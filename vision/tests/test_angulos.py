import math

import pytest

from app.estimador import Landmark
from app.filtros import Antirrebote, FiltroOneEuro
from app.geometria import angulo_3p
from app.miembro_inferior import INDICES, calcular_angulos, encuadre_ok, puntos_faltantes


@pytest.mark.parametrize("grados", [0, 30, 45, 90, 120, 180])
def test_angulo_3p_conocido(grados):
    rad = math.radians(grados)
    a = (1.0, 0.0)
    c = (math.cos(rad), math.sin(rad))
    assert angulo_3p(a, (0.0, 0.0), c) == pytest.approx(grados, abs=1e-6)


def test_angulo_3p_segmento_nulo():
    assert angulo_3p((0, 0), (0, 0), (1, 1)) is None


def _cuerpo(rodilla_der=(0.42, 0.65), visibilidad=0.9) -> list[Landmark]:
    """Persona de pie, centrada; se puede mover la rodilla derecha."""
    lms = [Landmark(0.5, 0.5, 0.0, visibilidad) for _ in range(33)]
    puntos = {
        "hombro_izq": (0.58, 0.25), "hombro_der": (0.42, 0.25),
        "cadera_izq": (0.56, 0.50), "cadera_der": (0.44, 0.50),
        "rodilla_izq": (0.56, 0.68), "rodilla_der": rodilla_der,
        "tobillo_izq": (0.56, 0.86), "tobillo_der": (0.44, 0.86),
        "talon_izq": (0.57, 0.89), "talon_der": (0.43, 0.89),
        "pie_izq": (0.53, 0.92), "pie_der": (0.47, 0.92),
    }
    for nombre, (x, y) in puntos.items():
        lms[INDICES[nombre]] = Landmark(x, y, 0.0, visibilidad)
    return lms


def test_pierna_extendida_da_180():
    angulos = calcular_angulos(_cuerpo(), 640, 480)
    assert angulos["rodilla_izq"] == pytest.approx(180, abs=0.5)


def test_rodilla_flexionada_reduce_el_angulo():
    angulos = calcular_angulos(_cuerpo(rodilla_der=(0.34, 0.66)), 640, 480)
    assert angulos["rodilla_der"] < 150


def test_angulo_usa_pixeles_no_coordenadas_normalizadas():
    # Cadera (0,0), rodilla (0.5,0), tobillo (0.5,0.5) en normalizado: 90° solo si ancho == alto.
    lms = _cuerpo()
    lms[INDICES["cadera_der"]] = Landmark(0.2, 0.2, 0, 0.9)
    lms[INDICES["rodilla_der"]] = Landmark(0.4, 0.2, 0, 0.9)
    lms[INDICES["tobillo_der"]] = Landmark(0.6, 0.4, 0, 0.9)
    cuadrada = calcular_angulos(lms, 480, 480)["rodilla_der"]
    ancha = calcular_angulos(lms, 640, 480)["rodilla_der"]
    assert cuadrada == pytest.approx(135, abs=0.1)
    assert ancha != pytest.approx(cuadrada, abs=1)


def test_baja_confianza_devuelve_none():
    lms = _cuerpo()
    lms[INDICES["tobillo_der"]] = Landmark(0.44, 0.86, 0, 0.2)
    angulos = calcular_angulos(lms, 640, 480)
    assert angulos["rodilla_der"] is None
    assert angulos["rodilla_izq"] is not None


def test_encuadre():
    assert encuadre_ok(_cuerpo())
    fuera = _cuerpo()
    fuera[INDICES["pie_der"]] = Landmark(0.47, 1.05, 0, 0.9)
    assert not encuadre_ok(fuera)


def test_puntos_faltantes_nombra_lo_que_no_se_ve():
    lms = _cuerpo()
    lms[INDICES["pie_der"]] = Landmark(0.47, 1.05, 0, 0.9)  # fuera de la imagen
    lms[INDICES["talon_izq"]] = Landmark(0.57, 0.89, 0, 0.1)  # baja visibilidad
    assert puntos_faltantes(lms) == ["talon_izq", "pie_der"]


def test_antirrebote_ignora_parpadeos_cortos():
    a = Antirrebote(espera_ms=300)
    assert a.actualizar(True, 0)
    assert a.actualizar(False, 100)  # parpadeo de un fotograma
    assert a.actualizar(True, 140)
    assert a.actualizar(False, 200)
    assert a.actualizar(False, 400)  # 200 ms: todavía no
    assert not a.actualizar(False, 520)  # 320 ms seguidos: cambia


def test_one_euro_reduce_ruido_sin_perder_el_nivel():
    filtro = FiltroOneEuro()
    ruido = [0.5 + (0.01 if i % 2 else -0.01) for i in range(60)]
    salida = [filtro.aplicar(x, i / 30) for i, x in enumerate(ruido)]
    variacion_entrada = max(ruido[30:]) - min(ruido[30:])
    variacion_salida = max(salida[30:]) - min(salida[30:])
    assert variacion_salida < variacion_entrada / 2
    assert salida[-1] == pytest.approx(0.5, abs=0.01)
