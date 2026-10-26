"""Ángulos clínicos de cadera, rodilla y tobillo, vista de la cámara y encuadre.

Los ángulos siguen la sección 4 de docs/reglas_rango_movimiento_miembro_inferior.md:
son ángulos clínicos (0° = posición anatómica de referencia), no el ángulo interno
entre segmentos.
"""
from .estimador import Landmark
from .geometria import a_pixeles, angulo_vectores, cruz
from .reglas import cargar

# Índices del modelo de 33 puntos de MediaPipe Pose.
INDICES = {
    "hombro_izq": 11, "hombro_der": 12,
    "cadera_izq": 23, "cadera_der": 24,
    "rodilla_izq": 25, "rodilla_der": 26,
    "tobillo_izq": 27, "tobillo_der": 28,
    "talon_izq": 29, "talon_der": 30,
    "pie_izq": 31, "pie_der": 32,
}
PARTES = ("hombro", "cadera", "rodilla", "tobillo", "talon", "pie")
NARIZ, OREJAS = 0, (7, 8)
LADOS = ("izq", "der")

UMBRAL_VISIBILIDAD = cargar().visibilidad_minima
MARGEN_IMAGEN = 0.02
# De lado, la distancia horizontal entre hombros (o caderas) es pequeña frente al largo del tronco.
RAZON_MAXIMA_LATERAL = 0.35


def _visible(p: Landmark, umbral: float) -> bool:
    return (
        p.visibilidad >= umbral
        and MARGEN_IMAGEN <= p.x <= 1 - MARGEN_IMAGEN
        and MARGEN_IMAGEN <= p.y <= 1 - MARGEN_IMAGEN
    )


def lado_mas_visible(lms: list[Landmark]) -> str:
    def promedio(lado: str) -> float:
        return sum(lms[INDICES[f"{p}_{lado}"]].visibilidad for p in PARTES) / len(PARTES)
    return "izq" if promedio("izq") > promedio("der") else "der"


def puntos_faltantes(lms: list[Landmark], lado: str | None = None,
                     umbral: float = UMBRAL_VISIBILIDAD) -> list[str]:
    """Puntos del lado medido que no se ven (CU-03). Sin lado, se usa el más visible.

    Con la cámara de lado (regla 4) el otro lado queda tapado por el cuerpo, así que solo
    se exige el lado que mira a la cámara.
    """
    lado = lado or lado_mas_visible(lms)
    return [f"{p}_{lado}" for p in PARTES if not _visible(lms[INDICES[f"{p}_{lado}"]], umbral)]


def encuadre_ok(lms: list[Landmark], lado: str | None = None, umbral: float = UMBRAL_VISIBILIDAD) -> bool:
    return not puntos_faltantes(lms, lado, umbral)


def vista(lms: list[Landmark], ancho: int, alto: int) -> dict:
    """¿La cámara ve al jugador de lado? ¿Qué lado está hacia la cámara?"""
    px = lambda nombre: a_pixeles(lms[INDICES[nombre]].x, lms[INDICES[nombre]].y, ancho, alto)
    centro = lambda a, b: ((px(a)[0] + px(b)[0]) / 2, (px(a)[1] + px(b)[1]) / 2)
    hombros, caderas = centro("hombro_izq", "hombro_der"), centro("cadera_izq", "cadera_der")
    tronco = max(1.0, ((hombros[0] - caderas[0]) ** 2 + (hombros[1] - caderas[1]) ** 2) ** 0.5)
    razon = max(abs(px("hombro_izq")[0] - px("hombro_der")[0]),
                abs(px("cadera_izq")[0] - px("cadera_der")[0])) / tronco
    # z de MediaPipe: menor = más cerca de la cámara.
    z = lambda lado: sum(lms[INDICES[f"{p}_{lado}"]].z for p in ("hombro", "cadera", "rodilla", "tobillo"))
    return {
        "lateral": razon <= RAZON_MAXIMA_LATERAL,
        "lado_camara": "izq" if z("izq") < z("der") else "der",
        "razon": round(razon, 2),
    }


def hacia_donde_mira(lms: list[Landmark], ancho: int, umbral: float = UMBRAL_VISIBILIDAD) -> int | None:
    """+1 si el jugador mira hacia la derecha de la imagen, −1 hacia la izquierda, None si no se sabe.

    Se usa la nariz respecto a las orejas: de perfil siempre apunta hacia adelante. El pie
    no sirve como referencia principal porque al doblar la rodilla más de 90° apunta hacia atrás.
    """
    nariz = lms[NARIZ]
    orejas = [lms[i] for i in OREJAS if lms[i].visibilidad >= umbral]
    if nariz.visibilidad >= umbral and orejas:
        dx = (nariz.x - sum(o.x for o in orejas) / len(orejas)) * ancho
        if abs(dx) >= 5:  # pixeles; de frente la nariz queda entre las orejas
            return 1 if dx > 0 else -1
    # Respaldo: un pie visible y apoyado de lado (talón → punta casi horizontal).
    for lado in LADOS:
        talon, pie = lms[INDICES[f"talon_{lado}"]], lms[INDICES[f"pie_{lado}"]]
        if talon.visibilidad >= umbral and pie.visibilidad >= umbral:
            dx, dy = (pie.x - talon.x) * ancho, (pie.y - talon.y) * ancho
            if abs(dx) > 2 * abs(dy):
                return 1 if dx > 0 else -1
    return None


def calcular_angulos(lms: list[Landmark], ancho: int, alto: int,
                     umbral: float = UMBRAL_VISIBILIDAD) -> dict[str, float | None]:
    """Ángulos clínicos por lado, en grados.

    rodilla_*: flexión (0° recta, + doblada, − hiperextensión).
    cadera_*:  flexión (0° de pie, 90° muslo horizontal, − extensión).
    tobillo_*: dorsiflexión (0° planta perpendicular a la pierna, + punta arriba, − flexión plantar).
    tronco_*:  inclinación del tronco respecto a la vertical (sin signo), para compensaciones.

    El signo de rodilla y cadera necesita saber hacia dónde mira el jugador (hacia_donde_mira).
    Si no se sabe (p. ej. vista frontal), se entrega la magnitud.
    None cuando alguno de los puntos tiene baja confianza: se descarta, no se inventa (regla 4).
    """
    angulos: dict[str, float | None] = {}
    mira = hacia_donde_mira(lms, ancho, umbral)
    for lado in LADOS:
        p = {parte: lms[INDICES[f"{parte}_{lado}"]] for parte in PARTES}
        v = {parte: punto.visibilidad >= umbral for parte, punto in p.items()}
        xy = {parte: a_pixeles(punto.x, punto.y, ancho, alto) for parte, punto in p.items()}
        vec = lambda a, b: (xy[b][0] - xy[a][0], xy[b][1] - xy[a][1])

        def flexion(a, b, c, signo_flexion):
            """Ángulo entre el segmento a→b prolongado y b→c, con signo según `mira`."""
            if not (v[a] and v[b] and v[c]):
                return None
            u, w = vec(a, b), vec(b, c)
            valor = angulo_vectores(u, w)
            if valor is None:
                return None
            if mira is not None and cruz(u, w) * mira * signo_flexion < 0:
                valor = -valor
            return round(valor, 1)

        # Mirando a +x en la imagen (y hacia abajo): el muslo que se adelanta da cruz < 0 y la
        # pierna que se va hacia atrás respecto al muslo da cruz > 0.
        angulos[f"cadera_{lado}"] = flexion("hombro", "cadera", "rodilla", -1)
        angulos[f"rodilla_{lado}"] = flexion("cadera", "rodilla", "tobillo", +1)

        if v["rodilla"] and v["tobillo"] and v["talon"] and v["pie"]:
            entre = angulo_vectores(vec("tobillo", "rodilla"), vec("talon", "pie"))
            angulos[f"tobillo_{lado}"] = None if entre is None else round(90 - entre, 1)
        else:
            angulos[f"tobillo_{lado}"] = None

        if v["hombro"] and v["cadera"]:
            inclinacion = angulo_vectores(vec("cadera", "hombro"), (0.0, -1.0))
            angulos[f"tronco_{lado}"] = None if inclinacion is None else round(inclinacion, 1)
        else:
            angulos[f"tronco_{lado}"] = None
    return angulos
