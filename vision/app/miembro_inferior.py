"""Landmarks de miembro inferior, verificación de encuadre y ángulos de cadera, rodilla y tobillo."""
from .estimador import Landmark
from .geometria import a_pixeles, angulo_3p

# Índices del modelo de 33 puntos de MediaPipe Pose.
INDICES = {
    "hombro_izq": 11, "hombro_der": 12,
    "cadera_izq": 23, "cadera_der": 24,
    "rodilla_izq": 25, "rodilla_der": 26,
    "tobillo_izq": 27, "tobillo_der": 28,
    "talon_izq": 29, "talon_der": 30,
    "pie_izq": 31, "pie_der": 32,
}

# (punto A, vértice B, punto C) por articulación, según el documento de arquitectura.
TRIADAS = {
    "rodilla": ("cadera", "rodilla", "tobillo"),
    "cadera": ("hombro", "cadera", "rodilla"),
    "tobillo": ("rodilla", "tobillo", "pie"),
}

UMBRAL_VISIBILIDAD = 0.5  # provisional: se ajusta en las pruebas (OE4)
MARGEN_IMAGEN = 0.02


def _visible(p: Landmark, umbral: float) -> bool:
    return (
        p.visibilidad >= umbral
        and MARGEN_IMAGEN <= p.x <= 1 - MARGEN_IMAGEN
        and MARGEN_IMAGEN <= p.y <= 1 - MARGEN_IMAGEN
    )


def puntos_faltantes(lms: list[Landmark], umbral: float = UMBRAL_VISIBILIDAD) -> list[str]:
    """Nombres de los puntos requeridos que no se ven; sirve para guiar al jugador (CU-03)."""
    return [nombre for nombre, i in INDICES.items() if not _visible(lms[i], umbral)]


def encuadre_ok(lms: list[Landmark], umbral: float = UMBRAL_VISIBILIDAD) -> bool:
    """Hombros, caderas, rodillas, tobillos y pies dentro de la imagen y visibles."""
    return not puntos_faltantes(lms, umbral)


def calcular_angulos(
    lms: list[Landmark], ancho: int, alto: int, umbral: float = UMBRAL_VISIBILIDAD
) -> dict[str, float | None]:
    """Ángulo interior (0–180°) en cada articulación y lado.

    Rodilla y cadera: 180° = segmento extendido. Tobillo: ángulo pierna-pie.
    None cuando alguno de los tres puntos tiene baja confianza (se descarta, no se inventa).
    La conversión a ángulo relativo a la posición neutra se hace en la calibración.
    """
    angulos: dict[str, float | None] = {}
    for articulacion, (a, b, c) in TRIADAS.items():
        for lado in ("izq", "der"):
            puntos = [lms[INDICES[f"{n}_{lado}"]] for n in (a, b, c)]
            if any(p.visibilidad < umbral for p in puntos):
                angulos[f"{articulacion}_{lado}"] = None
                continue
            pa, pb, pc = (a_pixeles(p.x, p.y, ancho, alto) for p in puntos)
            valor = angulo_3p(pa, pb, pc)
            angulos[f"{articulacion}_{lado}"] = None if valor is None else round(valor, 1)
    return angulos
