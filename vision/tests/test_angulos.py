import math

import pytest

from app.estimador import Landmark
from app.filtros import Antirrebote, FiltroOneEuro
from app.geometria import angulo_3p
from app.miembro_inferior import (INDICES, calcular_angulos, encuadre_ok, hacia_donde_mira, puntos_faltantes,
                                  vista)
from tests.cuerpo import ALTO, ANCHO, cuerpo_lateral


@pytest.mark.parametrize("grados", [0, 30, 45, 90, 120, 180])
def test_angulo_3p_conocido(grados):
    rad = math.radians(grados)
    assert angulo_3p((1.0, 0.0), (0.0, 0.0), (math.cos(rad), math.sin(rad))) == pytest.approx(grados, abs=1e-6)


def test_angulo_3p_segmento_nulo():
    assert angulo_3p((0, 0), (0, 0), (1, 1)) is None


# --- ángulos clínicos (regla 4) -----------------------------------------------

def test_de_pie_todo_en_cero():
    a = calcular_angulos(cuerpo_lateral(), ANCHO, ALTO)
    assert a["cadera_der"] == pytest.approx(0, abs=0.5)
    assert a["rodilla_der"] == pytest.approx(0, abs=0.5)
    assert a["tobillo_der"] == pytest.approx(0, abs=0.5)
    assert a["tronco_der"] == pytest.approx(0, abs=0.5)


@pytest.mark.parametrize("mira", [1, -1])
@pytest.mark.parametrize("rodilla", [30, 90, 120])
def test_flexion_de_rodilla(rodilla, mira):
    a = calcular_angulos(cuerpo_lateral(rodilla=rodilla, mira=mira), ANCHO, ALTO)
    assert a["rodilla_der"] == pytest.approx(rodilla, abs=0.5)


@pytest.mark.parametrize("mira", [1, -1])
def test_flexion_de_cadera_con_rodilla_doblada(mira):
    a = calcular_angulos(cuerpo_lateral(cadera=90, rodilla=90, mira=mira), ANCHO, ALTO)
    assert a["cadera_der"] == pytest.approx(90, abs=0.5)
    assert a["rodilla_der"] == pytest.approx(90, abs=0.5)


@pytest.mark.parametrize("mira", [1, -1])
def test_signos_extension_e_hiperextension(mira):
    a = calcular_angulos(cuerpo_lateral(cadera=-15, rodilla=-8, mira=mira), ANCHO, ALTO)
    assert a["cadera_der"] == pytest.approx(-15, abs=0.5)  # pierna hacia atrás = extensión
    assert a["rodilla_der"] == pytest.approx(-8, abs=0.5)  # hiperextensión


@pytest.mark.parametrize("tobillo", [-30, 0, 15, 25])
def test_dorsiflexion_y_flexion_plantar(tobillo):
    a = calcular_angulos(cuerpo_lateral(tobillo=tobillo), ANCHO, ALTO)
    assert a["tobillo_der"] == pytest.approx(tobillo, abs=0.5)


def test_inclinacion_del_tronco():
    a = calcular_angulos(cuerpo_lateral(tronco=20), ANCHO, ALTO)
    assert a["tronco_der"] == pytest.approx(20, abs=0.5)


def test_angulo_usa_pixeles_no_coordenadas_normalizadas():
    # 45° de rodilla en pixeles; si se ignora la proporción 4:3 de la imagen el ángulo cambia.
    a = calcular_angulos(cuerpo_lateral(rodilla=45), ANCHO, ALTO)
    assert a["rodilla_der"] == pytest.approx(45, abs=0.5)
    assert calcular_angulos(cuerpo_lateral(rodilla=45), ALTO, ALTO)["rodilla_der"] != pytest.approx(45, abs=2)


def test_cabeza_girada_contra_el_pie_no_decide_la_direccion():
    # De pie mirando a +x, pero con la cabeza girada hacia la pantalla (nariz hacia −x).
    lms = cuerpo_lateral(mira=1)
    nariz = lms[0]
    lms[0] = Landmark(nariz.x - 30 / ANCHO, nariz.y, nariz.z, nariz.visibilidad)
    assert hacia_donde_mira(lms, ANCHO) is None
    assert hacia_donde_mira(cuerpo_lateral(mira=1), ANCHO) == 1


def test_direccion_dada_por_quien_llama():
    # Con la dirección estable de la sesión, un fotograma ambiguo no invierte el signo.
    lms = cuerpo_lateral(rodilla=90, mira=1)
    lms[0] = Landmark(lms[0].x - 30 / ANCHO, lms[0].y, lms[0].z, lms[0].visibilidad)
    assert calcular_angulos(lms, ANCHO, ALTO, mira=1)["rodilla_der"] == pytest.approx(90, abs=0.5)
    assert calcular_angulos(lms, ANCHO, ALTO, mira=-1)["rodilla_der"] == pytest.approx(-90, abs=0.5)


def test_direccion_queda_fija_durante_una_actividad():
    from app.captura import BucleCaptura
    bucle = BucleCaptura(estimador=None, publicar=lambda m: None)
    derecha, izquierda = cuerpo_lateral(mira=1), cuerpo_lateral(mira=-1)
    t = 0
    for _ in range(50):
        t += 40
        bucle._mira(derecha, ANCHO, t)
    assert bucle._mira(derecha, ANCHO, t) == 1
    bucle.enviar_comando({"nombre": "calibrar", "ejercicio": "knee_flexion_standing", "lado": "der"})
    bucle._atender_comandos()
    bucle._controlador.actividad.vista_ok = True
    for _ in range(100):  # 4 s leyendo lo contrario: durante la actividad no cambia
        t += 40
        assert bucle._mira(izquierda, ANCHO, t) == 1


def test_rodilla_muy_doblada_no_invierte_el_signo():
    # Con la rodilla a 120° el pie apunta hacia atrás; la dirección se toma de la cara.
    a = calcular_angulos(cuerpo_lateral(rodilla=120, mira=-1), ANCHO, ALTO)
    assert a["rodilla_der"] == pytest.approx(120, abs=0.5)


def test_baja_visibilidad_descarta_el_angulo():
    lms = cuerpo_lateral()
    lms[INDICES["tobillo_der"]] = Landmark(lms[INDICES["tobillo_der"]].x, lms[INDICES["tobillo_der"]].y, 0, 0.55)
    a = calcular_angulos(lms, ANCHO, ALTO)
    assert a["rodilla_der"] is None and a["tobillo_der"] is None  # umbral de la regla: 0.6
    assert a["cadera_der"] is not None


# --- vista y encuadre ---------------------------------------------------------

def test_vista_lateral_y_lado_hacia_la_camara():
    assert vista(cuerpo_lateral(lado="der"), ANCHO, ALTO) == {"lateral": True, "lado_camara": "der", "razon": 0.04}
    assert vista(cuerpo_lateral(lado="izq"), ANCHO, ALTO)["lado_camara"] == "izq"


def test_vista_frontal_no_es_lateral():
    lms = cuerpo_lateral()
    for nombre, dx in (("hombro_izq", 60), ("cadera_izq", 40)):
        p = lms[INDICES[nombre]]
        lms[INDICES[nombre]] = Landmark(p.x + dx / ANCHO, p.y, p.z, p.visibilidad)
    assert not vista(lms, ANCHO, ALTO)["lateral"]


def test_encuadre_solo_exige_el_lado_medido():
    lms = cuerpo_lateral(lado="der")  # el lado izquierdo está tapado (visibilidad 0.3)
    assert encuadre_ok(lms, "der")
    assert not encuadre_ok(lms, "izq")
    assert encuadre_ok(lms)  # sin lado: usa el más visible


def test_puntos_faltantes_nombra_lo_que_no_se_ve():
    lms = cuerpo_lateral()
    p = lms[INDICES["pie_der"]]
    lms[INDICES["pie_der"]] = Landmark(p.x, 1.05, p.z, p.visibilidad)  # fuera de la imagen
    assert puntos_faltantes(lms, "der") == ["pie_der"]


# --- filtros ------------------------------------------------------------------

def test_antirrebote_ignora_parpadeos_cortos():
    a = Antirrebote(espera_ms=300)
    assert a.actualizar(True, 0)
    assert a.actualizar(False, 100)
    assert a.actualizar(True, 140)
    assert a.actualizar(False, 200)
    assert a.actualizar(False, 400)
    assert not a.actualizar(False, 520)


def test_one_euro_reduce_ruido_sin_perder_el_nivel():
    filtro = FiltroOneEuro()
    ruido = [0.5 + (0.01 if i % 2 else -0.01) for i in range(60)]
    salida = [filtro.aplicar(x, i / 30) for i, x in enumerate(ruido)]
    assert max(salida[30:]) - min(salida[30:]) < (max(ruido[30:]) - min(ruido[30:])) / 2
    assert salida[-1] == pytest.approx(0.5, abs=0.01)
