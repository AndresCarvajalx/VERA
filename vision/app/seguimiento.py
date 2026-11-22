"""Seguimiento temporal de la pose: de las detecciones sueltas de cada fotograma a un rastro estable.

El estimador entrega 33 puntos por fotograma, cada uno con su ruido. Aquí se resuelve lo que pasa
*entre* fotogramas, que es lo que el jugador percibe como temblor, parpadeo o saltos:

1. Suavizado One Euro por coordenada, ajustado para seguir sin retraso los movimientos rápidos.
2. Puntos tapados: cuanto menos visible es un punto, más despacio se le deja moverse (el modelo
   adivina su posición y la adivinanza baila).
3. Visibilidad estable: se promedia en el tiempo y tiene histéresis alrededor del umbral, para que un
   punto en el borde no entre y salga de la medición fotograma de por medio.
4. Huecos: si la persona se pierde unos pocos fotogramas, se sostiene la última pose en lugar de
   reportar "sin persona" y reiniciar todo.
5. Falsos positivos: una detección sin puntos confiables, o que aparece de golpe en otro lugar de la
   imagen (otra persona, un objeto), no reemplaza al jugador que se venía siguiendo.

No usa imágenes: solo los puntos. Por eso se prueba con poses sintéticas (tests/test_seguimiento.py).
"""
import math

from .estimador import Landmark, Pose
from .filtros import FiltroOneEuro, FiltroPasoBajo, _alfa

# Sin detección (o con una detección rechazada) se sostiene la última pose este tiempo: ~6 fotogramas.
SOSTENER_MS = 200
# Promedio temporal de la visibilidad: quita las caídas de un solo fotograma.
CORTE_VISIBILIDAD_HZ = 2.5
# Un punto que ya se medía se sigue midiendo hasta que su visibilidad baje este margen bajo el umbral.
HISTERESIS_VISIBILIDAD = 0.08
# Un punto casi invisible se mueve como mucho a esta fracción de la rapidez normal del filtro.
MOVILIDAD_MINIMA = 0.2
# Detección creíble: visibilidad media mínima de hombros, caderas, rodillas y tobillos.
PUNTOS_DEL_CUERPO = (11, 12, 23, 24, 25, 26, 27, 28)
VISIBILIDAD_MEDIA_MINIMA = 0.2
# Salto imposible: el centro del tronco se mueve más de este número de largos de tronco de un
# fotograma al siguiente (medio metro en 33 ms son 15 m/s).
SALTO_MAXIMO_TRONCOS = 1.0
TRONCO_MINIMO = 0.08  # en fracción de la imagen: evita que un tronco diminuto vuelva todo "salto"
SALTO_DT_MAXIMO_MS = 150  # con huecos más largos sí pudo moverse tanto


def _centro_y_tronco(lms: list[Landmark]) -> tuple[float, float, float]:
    hx, hy = (lms[11].x + lms[12].x) / 2, (lms[11].y + lms[12].y) / 2
    cx, cy = (lms[23].x + lms[24].x) / 2, (lms[23].y + lms[24].y) / 2
    return (hx + cx) / 2, (hy + cy) / 2, math.hypot(hx - cx, hy - cy)


class _Punto:
    """Filtros de un punto: 3 coordenadas de la imagen, 3 del mundo y su visibilidad."""

    def __init__(self) -> None:
        self.imagen = tuple(FiltroOneEuro() for _ in range(3))
        self.mundo = tuple(FiltroOneEuro() for _ in range(3))
        self.visibilidad = FiltroPasoBajo()
        self.medible = False  # si en el fotograma anterior quedó sobre el umbral


class SeguidorPose:
    def __init__(self, umbral_visibilidad: float) -> None:
        self.umbral = umbral_visibilidad
        self.sostenidas = 0  # fotogramas en los que se entregó la pose anterior (para diagnóstico)
        self.rechazadas = 0  # detecciones descartadas por no ser creíbles o por salto imposible
        self._puntos: list[_Punto] = []
        self._ultima: Pose | None = None
        self._t_ultima = 0
        self._referencia: tuple[float, float, float] | None = None  # centro y tronco sin suavizar

    def reiniciar(self) -> None:
        self._puntos, self._ultima, self._referencia = [], None, None

    def actualizar(self, pose: Pose | None, t_ms: int) -> Pose | None:
        """Devuelve la pose estabilizada, la anterior si hay un hueco corto, o None si no hay persona."""
        if pose is not None and not (self._creible(pose) and self._continua(pose, t_ms)):
            self.rechazadas += 1
            pose = None
        if pose is None:
            if self._ultima is not None and t_ms - self._t_ultima <= SOSTENER_MS:
                self.sostenidas += 1
                return self._ultima
            self.reiniciar()  # al reaparecer la persona no se arrastra la posición vieja
            return None

        dt = (t_ms - self._t_ultima) / 1000 if self._ultima is not None else 0.0
        if not self._puntos:
            self._puntos = [_Punto() for _ in pose.landmarks]
        t = t_ms / 1000
        landmarks, mundo = [], []
        for p, w, f in zip(pose.landmarks, pose.mundo, self._puntos):
            cruda = min(1.0, max(0.0, p.visibilidad))
            movilidad = MOVILIDAD_MINIMA + (1 - MOVILIDAD_MINIMA) * cruda
            x, y, z = (filtro.aplicar(valor, t, movilidad) for filtro, valor in zip(f.imagen, (p.x, p.y, p.z)))
            mundo.append(tuple(filtro.aplicar(valor, t, movilidad) for filtro, valor in zip(f.mundo, w)))
            suave = f.visibilidad.aplicar(cruda, _alfa(CORTE_VISIBILIDAD_HZ, dt) if dt > 0 else 1.0)
            # Histéresis: entra a la medición al pasar el umbral y solo sale si baja bastante más.
            if f.medible and self.umbral - HISTERESIS_VISIBILIDAD <= suave < self.umbral:
                suave = self.umbral
            f.medible = suave >= self.umbral
            landmarks.append(Landmark(x, y, z, suave))
        self._ultima, self._t_ultima = Pose(landmarks, mundo), t_ms
        self._referencia = _centro_y_tronco(pose.landmarks)
        return self._ultima

    @staticmethod
    def _creible(pose: Pose) -> bool:
        lms = pose.landmarks
        return sum(lms[i].visibilidad for i in PUNTOS_DEL_CUERPO) / len(PUNTOS_DEL_CUERPO) >= VISIBILIDAD_MEDIA_MINIMA

    def _continua(self, pose: Pose, t_ms: int) -> bool:
        """¿Es la misma persona que se venía siguiendo? Falso si apareció de golpe en otro lugar."""
        if self._referencia is None or t_ms - self._t_ultima > SALTO_DT_MAXIMO_MS:
            return True
        x0, y0, tronco = self._referencia
        x, y, _ = _centro_y_tronco(pose.landmarks)
        return math.hypot(x - x0, y - y0) <= SALTO_MAXIMO_TRONCOS * max(tronco, TRONCO_MINIMO)
