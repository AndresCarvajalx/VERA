"""Cálculo de ángulos articulares a partir de puntos clave.

θ = arccos[(BA · BC) / (|BA| · |BC|)], con B como vértice articular.
"""
import math

Punto = tuple[float, float]


def angulo_3p(a: Punto, b: Punto, c: Punto) -> float | None:
    """Ángulo interior en B (grados, 0–180). None si algún segmento tiene longitud cero."""
    bax, bay = a[0] - b[0], a[1] - b[1]
    bcx, bcy = c[0] - b[0], c[1] - b[1]
    norma = math.hypot(bax, bay) * math.hypot(bcx, bcy)
    if norma == 0:
        return None
    coseno = (bax * bcx + bay * bcy) / norma
    coseno = max(-1.0, min(1.0, coseno))  # evita errores numéricos fuera de [-1, 1]
    return math.degrees(math.acos(coseno))


def a_pixeles(x: float, y: float, ancho: int, alto: int) -> Punto:
    """MediaPipe normaliza x e y por separado; el ángulo solo es correcto en pixeles."""
    return (x * ancho, y * alto)
