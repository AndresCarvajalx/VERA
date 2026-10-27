"""Bucle de captura: cámara → pose → filtro → encuadre → ángulos → mensaje JSON.

Corre en un hilo propio. El fotograma solo existe en memoria y se descarta al
terminar cada iteración: hacia afuera solo salen landmarks, ángulos y eventos.
"""
import logging
import queue
import threading
import time
from collections import deque
from typing import Callable

import cv2

from . import trazas
from .controlador import Controlador
from .estimador import EstimadorPose, Landmark, Pose
from .filtros import Antirrebote, FiltroOneEuro
from .miembro_inferior import (INDICES, calcular_angulos, hacia_donde_mira, lado_mas_visible, puntos_faltantes,
                               vista)

log = logging.getLogger(__name__)

Publicar = Callable[[dict], None]


class MedidorFps:
    def __init__(self, ventana: int = 30) -> None:
        self._tiempos: deque[float] = deque(maxlen=ventana)

    def marcar(self, t: float) -> float:
        self._tiempos.append(t)
        if len(self._tiempos) < 2:
            return 0.0
        return (len(self._tiempos) - 1) / (self._tiempos[-1] - self._tiempos[0])


class LectorCamara:
    """Lee la cámara en su propio hilo y guarda solo el último fotograma.

    Así el estimador nunca espera a la cámara ni procesa fotogramas viejos: los FPS quedan
    limitados por el más lento de los dos, no por la suma (medido: 8.5 → ~16 FPS con poca luz).
    """

    def __init__(self, indice: int, ancho: int, alto: int) -> None:
        self._indice, self._ancho, self._alto = indice, ancho, alto
        self._camara: cv2.VideoCapture | None = None
        self._condicion = threading.Condition()
        self._ultimo: tuple[int, object, int] | None = None  # (secuencia, fotograma, t_captura)
        self._activo = False
        self._hilo: threading.Thread | None = None

    def abrir(self) -> bool:
        # Media Foundation y no DirectShow: con poca luz la cámara alarga la exposición y DirectShow
        # cae a 4.8 FPS, mientras MSMF sostiene ~16 (con buena luz ambos dan 30). Medido en el
        # equipo de desarrollo con herramientas/medir_rendimiento.py.
        self._camara = cv2.VideoCapture(self._indice, cv2.CAP_MSMF)
        self._camara.set(cv2.CAP_PROP_FRAME_WIDTH, self._ancho)
        self._camara.set(cv2.CAP_PROP_FRAME_HEIGHT, self._alto)
        if not self._camara.isOpened():
            return False
        self._activo = True
        self._hilo = threading.Thread(target=self._leer, name="lector-camara", daemon=True)
        self._hilo.start()
        return True

    def _leer(self) -> None:
        secuencia = 0
        while self._activo:
            ok, fotograma = self._camara.read()
            if not ok:
                time.sleep(0.01)
                continue
            secuencia += 1
            t_captura = int(time.time() * 1000)  # reloj del equipo, igual al del navegador
            with self._condicion:
                self._ultimo = (secuencia, fotograma, t_captura)  # reemplaza el anterior sin procesar
                self._condicion.notify()

    def siguiente(self, despues_de: int, timeout: float):
        """Espera un fotograma más nuevo que `despues_de`; None si no llega a tiempo."""
        with self._condicion:
            self._condicion.wait_for(lambda: self._ultimo and self._ultimo[0] > despues_de, timeout)
            if self._ultimo and self._ultimo[0] > despues_de:
                dato, self._ultimo = self._ultimo, None
                return dato
            return None

    def cerrar(self) -> None:
        self._activo = False
        if self._hilo:
            self._hilo.join(timeout=2)
        if self._camara:
            self._camara.release()


class BucleCaptura:
    def __init__(self, estimador: EstimadorPose, publicar: Publicar, indice_camara: int = 0,
                 ancho: int = 640, alto: int = 480) -> None:
        self._estimador = estimador
        self._publicar = publicar
        self._indice_camara = indice_camara
        self._ancho_pedido, self._alto_pedido = ancho, alto
        self._hilo: threading.Thread | None = None
        self._detener = threading.Event()
        self._filtros: list[tuple[FiltroOneEuro, ...]] = []
        self._encuadre_anterior: bool | None = None
        self._confianza_anterior: bool | None = None
        self._encuadre_estable = Antirrebote()
        # Hacia dónde mira el jugador (+1/−1): solo cambia si el cambio se mantiene 1.5 s, y no
        # cambia durante una actividad. Un signo invertido convierte 90° de flexión en −90°.
        self._mira_estable = Antirrebote(espera_ms=1500)
        self._confianza_estable = Antirrebote()
        # Los comandos llegan desde el hilo del servidor; el controlador solo se toca en este hilo.
        self._comandos: queue.Queue[dict] = queue.Queue()
        self._controlador = Controlador()

    def enviar_comando(self, datos: dict) -> None:
        self._comandos.put(datos)

    def _atender_comandos(self) -> None:
        while not self._comandos.empty():
            datos = self._comandos.get_nowait()
            log.info("Comando: %s", datos)
            for evento in self._controlador.comando(datos):
                self._evento(**evento)

    def iniciar(self) -> None:
        self._hilo = threading.Thread(target=self._correr, name="captura", daemon=True)
        self._hilo.start()

    def detener(self) -> None:
        self._detener.set()
        if self._hilo:
            self._hilo.join(timeout=3)

    def _suavizar(self, pose: Pose, t: float) -> Pose:
        """Un filtro One Euro por coordenada: 3 de la imagen y 3 del mundo para cada punto."""
        if not self._filtros:
            self._filtros = [tuple(FiltroOneEuro() for _ in range(6)) for _ in pose.landmarks]
        landmarks, mundo = [], []
        for p, w, (fx, fy, fz, wx, wy, wz) in zip(pose.landmarks, pose.mundo, self._filtros):
            landmarks.append(Landmark(fx.aplicar(p.x, t), fy.aplicar(p.y, t), fz.aplicar(p.z, t), p.visibilidad))
            mundo.append((wx.aplicar(w[0], t), wy.aplicar(w[1], t), wz.aplicar(w[2], t)))
        return Pose(landmarks, mundo)

    def _mira(self, lms: list[Landmark], ancho: int, t_ms: int) -> int | None:
        actividad = self._controlador.actividad
        fija = actividad is not None and actividad.vista_ok and self._mira_estable.valor is not None
        lectura = hacia_donde_mira(lms, ancho)
        if not fija and lectura is not None:
            self._mira_estable.actualizar(lectura, t_ms)
        return self._mira_estable.valor

    def _evento(self, nombre: str, **datos) -> None:
        log.info("Evento %s %s", nombre, datos or "")
        self._publicar({"tipo": "evento", "nombre": nombre, "t": int(time.time() * 1000), **datos})

    def _correr(self) -> None:
        lector = LectorCamara(self._indice_camara, self._ancho_pedido, self._alto_pedido)
        if not lector.abrir():
            log.error("No se pudo abrir la cámara %s", self._indice_camara)
            self._evento("camara_no_disponible")
            self._estimador.cerrar()
            return
        fps = MedidorFps()
        log.info("Cámara %s abierta", self._indice_camara)
        secuencia = 0
        try:
            while not self._detener.is_set():
                self._atender_comandos()
                dato = lector.siguiente(secuencia, timeout=0.5)
                if dato is None:
                    continue
                secuencia, fotograma, t_captura = dato
                alto, ancho = fotograma.shape[:2]
                pose = self._estimador.detectar(fotograma, t_captura)
                del fotograma  # el video nunca sale de aquí
                self._procesar(pose, t_captura, ancho, alto, fps.marcar(time.perf_counter()))
        finally:
            lector.cerrar()
            self._estimador.cerrar()

    def _procesar(self, pose: Pose | None, t_captura: int, ancho: int, alto: int, fps: float) -> None:
        lms, vista_actual = None, None
        # Con la cámara de lado solo se exige el lado medido (o, sin ejercicio, el más visible).
        lado = self._controlador.lado_activo
        if pose is None:
            self._filtros = []  # al reaparecer la persona no se arrastra la posición vieja
            encuadre, angulos, salida, mundo = False, {}, [], []
            faltan = [n for n in INDICES if lado is None or n.endswith(lado)]
        else:
            pose = self._suavizar(pose, t_captura / 1000)
            lms = pose.landmarks
            lado = lado or lado_mas_visible(lms)
            faltan = puntos_faltantes(lms, lado)
            encuadre = not faltan
            angulos = calcular_angulos(lms, ancho, alto, mira=self._mira(lms, ancho, t_captura))
            vista_actual = vista(lms, ancho, alto)
            salida = [[round(p.x, 4), round(p.y, 4), round(p.z, 4), round(p.visibilidad, 3)] for p in lms]
            mundo = [[round(c, 3) for c in w] for w in pose.mundo]

        encuadre = self._encuadre_estable.actualizar(encuadre, t_captura)
        if encuadre != self._encuadre_anterior:
            self._encuadre_anterior = encuadre
            if not encuadre:
                self._evento("fuera_de_encuadre")
        confianza = self._confianza_estable.actualizar(
            lms is not None and all(angulos.get(f"{a}_{lado}") is not None for a in ("cadera", "rodilla", "tobillo")),
            t_captura)
        if lms is not None and confianza != self._confianza_anterior:
            self._confianza_anterior = confianza
            if not confianza:
                self._evento("baja_confianza")

        extra, eventos = self._controlador.procesar(t_captura, angulos, vista_actual, fps)
        for evento in eventos:
            self._evento(**evento)
        if self._controlador.calibracion_terminada:
            ejercicio, lado, cal, resumen = self._controlador.calibracion_terminada
            self._controlador.calibracion_terminada = None
            try:
                log.info("Traza de calibración guardada en %s", trazas.guardar(ejercicio, lado, cal.traza, resumen))
            except OSError:
                log.exception("No se pudo guardar la traza de calibración")

        self._publicar({
            **extra,
            "tipo": "fotograma",
            "t_captura": t_captura,
            "fps": round(fps, 1),
            "imagen": [ancho, alto],
            "encuadre_ok": encuadre,
            "persona": lms is not None,
            "lado": lado,
            "vista": vista_actual,
            "faltan": faltan,
            "landmarks": salida,
            "mundo": mundo,
            "angulos": angulos,
        })
