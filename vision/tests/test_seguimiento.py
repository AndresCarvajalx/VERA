"""Estabilidad temporal del seguimiento, con poses sintéticas (sin cámara ni modelo)."""
import math
import random

import numpy as np
import pytest

from app.estimador import Landmark, Pose, preparar_imagen
from app.filtros import FiltroOneEuro
from app.miembro_inferior import INDICES, calcular_angulos
from app.seguimiento import SOSTENER_MS, SeguidorPose
from tests.cuerpo import ALTO, ANCHO, cuerpo_lateral

PASO_MS = 33
UMBRAL = 0.6


def pose(dx=0.0, visibilidad=None, **angulos) -> Pose:
    lms = cuerpo_lateral(**angulos)
    if dx:
        lms = [Landmark(p.x + dx, p.y, p.z, p.visibilidad) for p in lms]
    for nombre, v in (visibilidad or {}).items():
        p = lms[INDICES[nombre]]
        lms[INDICES[nombre]] = Landmark(p.x, p.y, p.z, v)
    return Pose(lms, [(p.x, p.y, p.z) for p in lms])


def seguir(seguidor, poses, t0=0):
    salidas, t = [], t0
    for p in poses:
        t += PASO_MS
        salidas.append(seguidor.actualizar(p, t))
    return salidas, t


# --- filtro: rápido cuando hay movimiento, firme en reposo ------------------------------

def retraso_ms(filtro: FiltroOneEuro, rapidez=0.5) -> float:
    """Cuánto tarda el filtro en llegar a donde ya está un punto que se mueve a `rapidez` (0–1 por s)."""
    t = x = 0.0
    for _ in range(60):
        t += PASO_MS / 1000
        x = filtro.aplicar(rapidez * t, t)
    return (rapidez * t - x) / rapidez * 1000


def temblor(filtro: FiltroOneEuro, ruido=0.002) -> float:
    azar, t, salidas = random.Random(1), 0.0, []
    for _ in range(300):
        t += PASO_MS / 1000
        salidas.append(filtro.aplicar(0.5 + azar.gauss(0, ruido), t))
    return float(np.std(salidas[60:]))


def test_el_filtro_sigue_los_movimientos_rapidos_sin_retraso():
    assert retraso_ms(FiltroOneEuro(corte_min=1.0, beta=0.05)) > 120  # los valores anteriores
    assert retraso_ms(FiltroOneEuro()) < 40


def test_el_filtro_sigue_quitando_el_temblor_en_reposo():
    assert temblor(FiltroOneEuro()) < 0.002 * 0.6  # al menos 40 % menos que la lectura cruda


def test_un_punto_poco_confiable_se_mueve_mas_despacio():
    confiable, dudoso, t = FiltroOneEuro(), FiltroOneEuro(), 0.0
    for filtro in (confiable, dudoso):
        filtro.aplicar(0.2, 0.0)
    a = confiable.aplicar(0.5, 0.033, 1.0)
    b = dudoso.aplicar(0.5, 0.033, 0.2)
    assert 0.2 < b < a < 0.5


# --- seguidor ------------------------------------------------------------------------------

def test_el_angulo_no_se_recorta_en_un_movimiento_rapido():
    """Doblar la rodilla 0 → 90° en 0,4 s y sostener: el ángulo medido llega a 90° casi de inmediato."""
    seguidor = SeguidorPose(UMBRAL)
    subida = [pose(rodilla=90 * i / 12) for i in range(13)]
    salidas, _ = seguir(seguidor, [pose()] * 20 + subida + [pose(rodilla=90)] * 3)
    angulo = calcular_angulos(salidas[-1].landmarks, ANCHO, ALTO, mira=1)["rodilla_der"]
    assert angulo == pytest.approx(90, abs=4)


def test_un_hueco_corto_sostiene_la_pose_y_uno_largo_la_suelta():
    seguidor = SeguidorPose(UMBRAL)
    salidas, t = seguir(seguidor, [pose()] * 10)
    quieta = salidas[-1]
    hueco, t = seguir(seguidor, [None] * (SOSTENER_MS // PASO_MS), t)
    assert all(s is quieta for s in hueco) and seguidor.sostenidas == len(hueco)
    largo, _ = seguir(seguidor, [None] * 3, t)
    assert largo[-1] is None


def test_la_visibilidad_no_parpadea_alrededor_del_umbral():
    """Un tobillo cuya visibilidad oscila entre 0,56 y 0,64 no entra y sale de la medición."""
    seguidor = SeguidorPose(UMBRAL)
    seguir(seguidor, [pose()] * 10)
    poses = [pose(visibilidad={"tobillo_der": 0.64 if i % 2 else 0.56}) for i in range(60)]
    salidas, _ = seguir(seguidor, poses)
    medibles = [s.landmarks[INDICES["tobillo_der"]].visibilidad >= UMBRAL for s in salidas]
    assert all(medibles)
    crudas = [p.landmarks[INDICES["tobillo_der"]].visibilidad >= UMBRAL for p in poses]
    assert sum(a != b for a, b in zip(crudas, crudas[1:])) > 50  # sin el seguidor: parpadeo continuo


def test_un_punto_que_de_verdad_se_tapa_deja_de_medirse():
    seguidor = SeguidorPose(UMBRAL)
    seguir(seguidor, [pose()] * 10)
    salidas, _ = seguir(seguidor, [pose(visibilidad={"tobillo_der": 0.2})] * 30)
    assert salidas[-1].landmarks[INDICES["tobillo_der"]].visibilidad < UMBRAL


def test_una_deteccion_que_aparece_en_otro_lugar_no_reemplaza_al_jugador():
    """Falso positivo de un fotograma (otra persona u objeto): se sigue entregando al jugador."""
    seguidor = SeguidorPose(UMBRAL)
    salidas, t = seguir(seguidor, [pose()] * 10)
    quieta = salidas[-1]
    salto, t = seguir(seguidor, [pose(dx=0.4)], t)
    assert salto[0] is quieta and seguidor.rechazadas == 1
    vuelve, _ = seguir(seguidor, [pose()], t)
    assert vuelve[0].landmarks[23].x == pytest.approx(quieta.landmarks[23].x, abs=0.002)


def test_si_el_jugador_si_se_movio_se_le_vuelve_a_seguir():
    seguidor = SeguidorPose(UMBRAL)
    _, t = seguir(seguidor, [pose()] * 10)
    salidas, _ = seguir(seguidor, [pose(dx=0.4)] * 12, t)
    assert salidas[-1].landmarks[23].x == pytest.approx(pose(dx=0.4).landmarks[23].x, abs=0.002)


def test_una_deteccion_sin_puntos_confiables_no_es_una_persona():
    seguidor = SeguidorPose(UMBRAL)
    fantasma = pose()
    fantasma = Pose([Landmark(p.x, p.y, p.z, 0.05) for p in fantasma.landmarks], fantasma.mundo)
    assert seguidor.actualizar(fantasma, 0) is None


def test_un_punto_tapado_no_baila():
    """Con el tobillo tapado el modelo lo ubica al azar: el seguidor lo mueve mucho menos."""
    azar, seguidor = random.Random(3), SeguidorPose(UMBRAL)
    seguir(seguidor, [pose()] * 10)
    crudas, suaves = [], []
    for i in range(60):
        p = pose(visibilidad={"tobillo_der": 0.1})
        lm = p.landmarks[INDICES["tobillo_der"]]
        p.landmarks[INDICES["tobillo_der"]] = Landmark(lm.x + azar.gauss(0, 0.02), lm.y, lm.z, 0.1)
        crudas.append(p.landmarks[INDICES["tobillo_der"]].x)
        suaves.append(seguidor.actualizar(p, 1000 + i * PASO_MS).landmarks[INDICES["tobillo_der"]].x)
    assert np.std(suaves[20:]) < 0.5 * np.std(crudas[20:])


# --- preparación de la imagen -----------------------------------------------------------------

def test_una_imagen_grande_se_reduce_sin_cambiar_su_proporcion():
    rgb = preparar_imagen(np.full((1080, 1920, 3), 120, np.uint8))
    assert rgb.shape == (540, 960, 3)


def test_una_imagen_oscura_se_aclara_y_una_normal_no_se_toca():
    oscura = np.full((480, 640, 3), 30, np.uint8)
    assert 90 < preparar_imagen(oscura).mean() < 130
    normal = np.full((480, 640, 3), 120, np.uint8)
    assert preparar_imagen(normal).mean() == 120
    assert math.isclose(preparar_imagen(np.zeros((480, 640, 3), np.uint8)).mean(), 0)  # negra: no hay qué aclarar
