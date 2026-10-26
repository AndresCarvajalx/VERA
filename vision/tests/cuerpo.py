"""Persona simulada vista de lado, con ángulos clínicos conocidos, para las pruebas."""
import math

from app.estimador import Landmark
from app.miembro_inferior import INDICES

ANCHO, ALTO = 640, 480
LARGO = {"tronco": 150, "muslo": 100, "pierna": 100, "talon": 12, "pie": 45}  # pixeles


def _dir(phi_grados: float, mira: int) -> tuple[float, float]:
    """Dirección en la imagen a `phi` grados desde "hacia abajo", girando hacia donde mira."""
    phi = math.radians(phi_grados)
    return (mira * math.sin(phi), math.cos(phi))


def cuerpo_lateral(cadera=0.0, rodilla=0.0, tobillo=0.0, tronco=0.0, mira=1, lado="der",
                   visibilidad=0.95) -> list[Landmark]:
    """Landmarks de alguien de perfil, con `lado` hacia la cámara y mirando a +x (mira=1) o −x.

    cadera, rodilla, tobillo: flexión de cadera, flexión de rodilla y dorsiflexión (grados clínicos).
    tronco: inclinación del tronco hacia atrás respecto a la vertical.
    """
    cad = (300.0, 230.0)
    sum_ = lambda p, d, l: (p[0] + d[0] * l, p[1] + d[1] * l)
    hombro = sum_(cad, _dir(180 + tronco, -mira), LARGO["tronco"])
    rod = sum_(cad, _dir(cadera, mira), LARGO["muslo"])
    phi_pierna = cadera - rodilla
    tob = sum_(rod, _dir(phi_pierna, mira), LARGO["pierna"])
    talon = sum_(tob, _dir(phi_pierna, mira), LARGO["talon"])
    pie = sum_(talon, _dir(phi_pierna + 90 + tobillo, mira), LARGO["pie"])
    puntos = {"hombro": hombro, "cadera": cad, "rodilla": rod, "tobillo": tob, "talon": talon, "pie": pie}

    otro = "izq" if lado == "der" else "der"
    lms = [Landmark(0.5, 0.5, 0.0, 0.1) for _ in range(33)]
    # Cara de perfil: la nariz adelante de las orejas.
    lms[0] = Landmark((hombro[0] + 15 * mira) / ANCHO, (hombro[1] - 45) / ALTO, -0.2, visibilidad)
    for oreja in (7, 8):
        lms[oreja] = Landmark((hombro[0] - 5 * mira) / ANCHO, (hombro[1] - 40) / ALTO, 0.0, visibilidad)
    for parte, (x, y) in puntos.items():
        lms[INDICES[f"{parte}_{lado}"]] = Landmark(x / ANCHO, y / ALTO, -0.1, visibilidad)
        # El lado de atrás queda casi en el mismo lugar, más lejos y tapado.
        lms[INDICES[f"{parte}_{otro}"]] = Landmark((x + 6) / ANCHO, y / ALTO, 0.1, 0.3)
    return lms
