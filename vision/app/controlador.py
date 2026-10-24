"""Controlador del ejercicio: atiende los comandos del navegador y aplica calibración y conteo.

Comandos (del navegador al servicio):
    calibrar
    iniciar_ejercicio {ejercicio, articulacion, lado, objetivo, tolerancia, tiempo_sostenido_ms, repeticiones, sentido}
    pausar | reanudar | detener

Eventos (del servicio al navegador):
    calibracion_lista, calibracion_fallida, rep_valida, rep_incompleta, serie_completa,
    ejercicio_detenido, comando_rechazado
"""
from dataclasses import dataclass

from .calibracion import Calibrador, angulos_relativos
from .miembro_inferior import TRIADAS
from .repeticiones import ContadorRepeticiones

LADOS = ("izq", "der")


class ComandoInvalido(Exception):
    pass


@dataclass
class Ejercicio:
    ejercicio: str
    articulacion: str
    lado: str
    sentido: int  # +1: se mide el cierre (flexión, dorsiflexión); -1: la apertura
    repeticiones_meta: int
    contador: ContadorRepeticiones
    amplitud_max: float | None = None
    amplitud_min: float | None = None

    @property
    def clave(self) -> str:
        return f"{self.articulacion}_{self.lado}"


def _numero(datos: dict, nombre: str, minimo: float, maximo: float, por_defecto=None) -> float:
    valor = datos.get(nombre, por_defecto)
    if not isinstance(valor, (int, float)) or isinstance(valor, bool) or not minimo <= valor <= maximo:
        raise ComandoInvalido(f"{nombre} debe ser un número entre {minimo} y {maximo}")
    return valor


def ejercicio_desde_comando(datos: dict) -> Ejercicio:
    articulacion = datos.get("articulacion")
    if articulacion not in TRIADAS:
        raise ComandoInvalido(f"articulacion debe ser una de {sorted(TRIADAS)}")
    lado = datos.get("lado")
    if lado not in LADOS:
        raise ComandoInvalido("lado debe ser 'izq' o 'der'")
    sentido = datos.get("sentido", 1)
    if sentido not in (1, -1):
        raise ComandoInvalido("sentido debe ser 1 o -1")
    # Límites de seguridad del protocolo; los valores reales los fija el fisioterapeuta (CU-12).
    objetivo = _numero(datos, "objetivo", 5, 150)
    tolerancia = _numero(datos, "tolerancia", 0, 30, 5)
    if tolerancia >= objetivo:
        raise ComandoInvalido("tolerancia debe ser menor que objetivo")
    return Ejercicio(
        ejercicio=str(datos.get("ejercicio", f"{articulacion}_{lado}")),
        articulacion=articulacion,
        lado=lado,
        sentido=sentido,
        repeticiones_meta=int(_numero(datos, "repeticiones", 1, 50, 10)),
        contador=ContadorRepeticiones(
            objetivo=objetivo,
            tolerancia=tolerancia,
            tiempo_sostenido_ms=int(_numero(datos, "tiempo_sostenido_ms", 0, 30000, 1000)),
        ),
    )


class Controlador:
    def __init__(self) -> None:
        self.calibrador = Calibrador()
        self.calibrando = False
        self.neutros: dict[str, float] = {}
        self.ejercicio: Ejercicio | None = None
        self.pausado = False
        self._fps: list[float] = []

    # --- comandos -------------------------------------------------------------
    def comando(self, datos: dict) -> list[dict]:
        """Aplica un comando. Devuelve los eventos que genera."""
        nombre = datos.get("nombre")
        try:
            if nombre == "calibrar":
                # Recalibrar siempre está permitido: si había un ejercicio, se cierra con su resumen,
                # porque sus amplitudes dependían de la neutra anterior.
                eventos = [self._terminar("ejercicio_detenido")] if self.ejercicio else []
                self.calibrador.reiniciar()
                self.calibrando = True
                return eventos
            if nombre == "iniciar_ejercicio":
                if not self.neutros:
                    raise ComandoInvalido("primero hay que calibrar la posición neutra")
                ejercicio = ejercicio_desde_comando(datos)
                if ejercicio.clave not in self.neutros:
                    raise ComandoInvalido(f"la calibración no incluyó {ejercicio.clave}")
                self.ejercicio, self.pausado, self._fps = ejercicio, False, []
                return []
            if nombre in ("pausar", "reanudar"):
                if not self.ejercicio:
                    raise ComandoInvalido("no hay ejercicio en curso")
                self.pausado = nombre == "pausar"
                return []
            if nombre == "detener":
                if not self.ejercicio:
                    raise ComandoInvalido("no hay ejercicio en curso")
                return [self._terminar("ejercicio_detenido")]
            raise ComandoInvalido(f"comando desconocido: {nombre}")
        except ComandoInvalido as e:
            return [{"nombre": "comando_rechazado", "comando": nombre, "motivo": str(e)}]

    # --- fotogramas -------------------------------------------------------------
    def procesar(self, t_ms: int, angulos: dict, encuadre_ok: bool, fps: float) -> tuple[dict, list[dict]]:
        """Devuelve los campos extra del mensaje de fotograma y los eventos generados."""
        eventos: list[dict] = []
        extra: dict = {}

        if self.calibrando:
            resultado = self.calibrador.agregar(t_ms, angulos, encuadre_ok)
            extra["calibracion"] = {"progreso": round(self.calibrador.progreso(t_ms), 2)}
            if resultado:
                self.calibrando = False
                estado, dato = resultado
                if estado == "lista":
                    self.neutros = dato
                    eventos.append({"nombre": "calibracion_lista", "neutros": dato})
                else:
                    eventos.append({"nombre": "calibracion_fallida", "motivo": dato})

        if self.neutros:
            extra["angulos_rel"] = angulos_relativos(angulos, self.neutros)

        ej = self.ejercicio
        if ej:
            # Durante el ejercicio solo importa la articulación que se mide: exigir el cuerpo
            # completo pausaba el reto cada vez que un pie salía de cuadro al mover la pierna.
            relativo = extra["angulos_rel"].get(ej.clave)
            amplitud = None if relativo is None else ej.sentido * relativo
            visible = amplitud is not None
            activo = not self.pausado and visible
            if activo:
                self._fps.append(fps)
                if amplitud is not None:
                    ej.amplitud_max = amplitud if ej.amplitud_max is None else max(ej.amplitud_max, amplitud)
                    ej.amplitud_min = amplitud if ej.amplitud_min is None else min(ej.amplitud_min, amplitud)
                resultado = ej.contador.actualizar(t_ms, amplitud)
                if resultado:
                    rep = ej.contador.repeticiones[-1]
                    eventos.append({"nombre": resultado, "numero": rep.numero,
                                    "angulo_pico": rep.angulo_pico, "sostenido_ms": rep.sostenido_ms})
            extra["rep"] = {
                "ejercicio": ej.ejercicio,
                "estado": "pausado" if self.pausado else ej.contador.estado if visible else "no_visible",
                "amplitud_max": None if ej.amplitud_max is None else round(ej.amplitud_max, 1),
                "sentido": ej.sentido,
                "amplitud": None if amplitud is None else round(amplitud, 1),
                "objetivo": ej.contador.objetivo,
                "tolerancia": ej.contador.tolerancia,
                "validas": ej.contador.validas,
                "intentadas": len(ej.contador.repeticiones),
                "meta": ej.repeticiones_meta,
                "sostenido_ms": ej.contador.sostenido_ms,
                "tiempo_sostenido_ms": ej.contador.tiempo_sostenido_ms,
            }
            if ej.contador.validas >= ej.repeticiones_meta:
                eventos.append(self._terminar("serie_completa"))
        return extra, eventos

    def _terminar(self, nombre: str) -> dict:
        """Cierra el ejercicio y arma el resumen (lo que luego guarda ResultadoEjercicio)."""
        ej = self.ejercicio
        self.ejercicio = None
        rango = None
        if ej.amplitud_max is not None:
            rango = round(ej.amplitud_max - ej.amplitud_min, 1)
        return {
            "nombre": nombre,
            "resumen": {
                "ejercicio": ej.ejercicio,
                "articulacion": ej.articulacion,
                "lado": ej.lado,
                "neutro": self.neutros.get(ej.clave),
                "amplitud_max": None if ej.amplitud_max is None else round(ej.amplitud_max, 1),
                "amplitud_min": None if ej.amplitud_min is None else round(ej.amplitud_min, 1),
                "rango": rango,
                "validas": ej.contador.validas,
                "intentadas": len(ej.contador.repeticiones),
                "repeticiones": [vars(r) for r in ej.contador.repeticiones],
                "fps_promedio": round(sum(self._fps) / len(self._fps), 1) if self._fps else None,
            },
        }
