import pytest

from app.controlador import Controlador, FiltroSaltos, VigiaTalon, crear_contador
from app.miembro_inferior import calcular_angulos, vista as medir_vista
from app.reglas import cargar
from app.repeticiones import ContadorRepeticiones, Repeticion

from .cuerpo import ALTO, ANCHO, cuerpo_lateral

PASO_MS = 40  # ~25 FPS
LATERAL_DER = {"lateral": True, "lado_camara": "der", "razon": 0.05}
FRONTAL = {"lateral": False, "lado_camara": "der", "razon": 0.8}
SENTADO_DER = {**LATERAL_DER, "muslo_horizontal": True}


def rampa(desde, hasta, pasos=12):
    return [desde + (hasta - desde) * i / (pasos - 1) for i in range(pasos)]


def correr(ctrl, valores, clave="rodilla_der", extra=None, vista=LATERAL_DER, t0=0):
    """Pasa una serie de ángulos (uno por fotograma). Devuelve eventos, último extra y tiempo."""
    eventos, t, salida = [], t0, {}
    for v in valores:
        t += PASO_MS
        angulos = {clave: v, **(extra or {})}
        salida, ev = ctrl.procesar(t, angulos, vista, 25.0)
        eventos += ev
    return eventos, salida, t


def nombres(eventos):
    return [e["nombre"] for e in eventos]


def iniciar(ctrl, **datos):
    datos = {"nombre": "iniciar_ejercicio", "ejercicio": "knee_flexion_standing", "lado": "der",
             "repeticiones": 2, **datos}
    assert ctrl.comando(datos) == []


def preparar_vista(ctrl, angulo=0.0, clave="rodilla_der"):
    """Un segundo de lado y quieto: la vista queda verificada y el contador armado."""
    eventos, _, t = correr(ctrl, [angulo] * 30, clave)
    assert "vista_ok" in nombres(eventos)
    return t


# --- reglas cargadas del JSON ------------------------------------------------------

def test_catalogo_de_las_reglas():
    reglas = cargar()
    assert set(reglas.ejercicios) == {"knee_flexion_standing", "knee_extension_seated",
                                      "hip_flexion_standing", "ankle_dorsiflexion_standing"}
    assert reglas.visibilidad_minima == 0.6 and reglas.tolerancia_medicion == 10
    rodilla = reglas.ejercicios["knee_flexion_standing"]
    assert (rodilla.inicio, rodilla.meta_por_defecto, rodilla.max_fisiologico) == (10, 90, 120)
    assert rodilla.compensacion.angulo == "cadera" and rodilla.compensacion.maximo == 20
    extension = reglas.ejercicios["knee_extension_seated"]
    assert (extension.direccion, extension.inicio, extension.retorno) == ("abajo", 80, 60)


@pytest.mark.parametrize("ejercicio,meta,valida", [
    ("knee_flexion_standing", 90, True), ("knee_flexion_standing", 121, False),
    ("knee_flexion_standing", 8, False), ("ankle_dorsiflexion_standing", 30, True),
    ("ankle_dorsiflexion_standing", 35, False), ("knee_extension_seated", 10, True),
    ("knee_extension_seated", -15, False), ("hip_flexion_standing", 120, True),
])
def test_meta_nunca_supera_el_limite_fisiologico(ejercicio, meta, valida):
    assert cargar().ejercicios[ejercicio].meta_valida(meta) is valida


# --- filtro de saltos (regla 5) ----------------------------------------------------

def test_salto_mayor_a_30_es_ruido():
    f = FiltroSaltos(30)
    assert f.aplicar(10) == 10
    assert f.aplicar(80) is None  # salto de 70° en un fotograma
    assert f.aplicar(12) == 12


def test_salto_sostenido_se_acepta():
    f = FiltroSaltos(30)
    f.aplicar(10)
    assert [f.aplicar(80), f.aplicar(81), f.aplicar(80)] == [None, None, 80]


# --- vista lateral ----------------------------------------------------------------

def test_no_mide_hasta_estar_de_lado():
    ctrl = Controlador()
    iniciar(ctrl)
    eventos, extra, _ = correr(ctrl, [0.0] * 40, vista=FRONTAL)
    assert extra["rep"]["fase"] == "verificando_vista" and "vista_ok" not in nombres(eventos)


def test_exige_el_lado_elegido_hacia_la_camara():
    ctrl = Controlador()
    iniciar(ctrl, lado="izq")
    _, extra, _ = correr(ctrl, [0.0] * 40, clave="rodilla_izq")  # la cámara ve el lado derecho
    assert extra["rep"]["fase"] == "verificando_vista"


# --- juego: repeticiones con las reglas --------------------------------------------

def test_flexion_de_rodilla_valida():
    ctrl = Controlador()
    iniciar(ctrl, meta=60)
    t = preparar_vista(ctrl)
    eventos, extra, _ = correr(ctrl, rampa(0, 58) + rampa(58, 0), t0=t)  # 58 ≥ 60 − 5
    assert nombres(eventos) == ["rep_valida"]
    assert eventos[0]["angulo_pico"] == pytest.approx(58)
    assert extra["rep"]["validas"] == 1


def test_no_llegar_a_la_meta_es_incompleta():
    ctrl = Controlador()
    iniciar(ctrl, meta=60)
    t = preparar_vista(ctrl)
    eventos, _, _ = correr(ctrl, rampa(0, 40) + rampa(40, 0), t0=t)
    assert nombres(eventos) == ["rep_incompleta"] and eventos[0]["motivo"] == "no_llego"


def test_compensacion_invalida_la_repeticion():
    ctrl = Controlador()
    iniciar(ctrl, meta=60)
    t = preparar_vista(ctrl)
    # A la mitad del movimiento el muslo se adelanta 25° (> 20° de la regla 3.1).
    subida = [(a, {"cadera_der": 25.0 if a > 30 else 0.0}) for a in rampa(0, 62)]
    eventos = []
    for angulo, extra in subida + [(a, {"cadera_der": 0.0}) for a in rampa(62, 0)]:
        t += PASO_MS
        eventos += ctrl.procesar(t, {"rodilla_der": angulo, **extra}, LATERAL_DER, 25.0)[1]
    assert nombres(eventos) == ["compensacion", "rep_incompleta"]
    assert eventos[0]["mensaje"] == "Mantén el muslo vertical"
    assert eventos[1]["motivo"] == "compensacion"


@pytest.mark.parametrize("pico, motivo, esperada", [
    (62.0, None, "perfecto"),  # pasó la meta
    (58.0, None, "bien"),  # válida, dentro de la tolerancia
    (45.0, "no_llego", "casi"),  # (45 − 10) / (55 − 10) = 78 % del recorrido
    (40.0, "no_llego", "mal"),  # 67 %
    (58.0, "no_sostuvo", "casi"),
    (62.0, "compensacion", "mal"),  # llegó, pero no con el movimiento pedido
])
def test_calidad_de_la_repeticion(pico, motivo, esperada):
    contador = ContadorRepeticiones(umbral_meta=55, umbral_inicio=10, umbral_arranque=10)
    rep = Repeticion(1, pico, 0, motivo is None, motivo)
    assert contador.calidad(rep, 60, 0.75) == esperada


@pytest.mark.parametrize("pico, motivo, esperada", [
    (8.0, None, "perfecto"),  # estirar más es bajar el ángulo
    (12.0, None, "bien"),
    (30.0, "no_llego", "casi"),  # (60 − 30) / (60 − 15) = 67 % del recorrido; aquí basta con 60 %
    (40.0, "no_llego", "mal"),
])
def test_calidad_en_ejercicios_hacia_abajo(pico, motivo, esperada):
    contador = ContadorRepeticiones(umbral_meta=-15, umbral_inicio=-60, umbral_arranque=-60, signo=-1)
    rep = Repeticion(1, pico, 0, motivo is None, motivo)
    assert contador.calidad(rep, 10, 0.6) == esperada


def test_el_evento_de_la_repeticion_trae_su_calidad():
    ctrl = Controlador()
    iniciar(ctrl, meta=60)
    t = preparar_vista(ctrl)
    eventos, _, _ = correr(ctrl, rampa(0, 62) + rampa(62, 0), t0=t)
    assert eventos[0]["calidad"] == "perfecto"


# --- subir la punta del pie: el talón sigue apoyado ------------------------------------

def correr_cuerpo(ctrl, poses, t0=0):
    """Como `correr`, pero con ángulos y vista medidos sobre un cuerpo completo."""
    eventos, t = [], t0
    for pose in poses:
        t += PASO_MS
        lms = cuerpo_lateral(**pose)
        eventos += ctrl.procesar(t, calcular_angulos(lms, ANCHO, ALTO, mira=1), medir_vista(lms, ANCHO, ALTO), 25.0)[1]
    return eventos, t


def iniciar_tobillo(ctrl):
    iniciar(ctrl, ejercicio="ankle_dorsiflexion_standing", meta=15, repeticiones=3)
    eventos, t = correr_cuerpo(ctrl, [{}] * 30)
    assert "vista_ok" in nombres(eventos)
    return t


def test_subir_la_punta_con_el_talon_apoyado_es_valido():
    ctrl = Controlador()
    t = iniciar_tobillo(ctrl)
    eventos, _ = correr_cuerpo(ctrl, [{"tobillo": a} for a in rampa(0, 20) + rampa(20, 0)], t0=t)
    assert nombres(eventos) == ["rep_valida"]


def test_subir_la_pierna_no_cuenta_aunque_el_tobillo_llegue_a_la_meta():
    """Caso real: al subir toda la pierna el pie cambia de ángulo y se contaba como repetición."""
    ctrl = Controlador()
    t = iniciar_tobillo(ctrl)
    subida = [{"cadera": c, "tobillo": a} for c, a in zip(rampa(0, 40), rampa(0, 20))]
    eventos, _ = correr_cuerpo(ctrl, subida + subida[::-1], t0=t)
    assert nombres(eventos) == ["compensacion", "rep_incompleta"]
    assert eventos[0]["mensaje"] == "Deja el talón apoyado en el piso"
    assert eventos[1]["motivo"] == "compensacion" and eventos[1]["calidad"] == "mal"


def test_subir_la_pierna_no_cuenta_como_intento_de_calibracion():
    ctrl = Controlador()
    ctrl.comando({"nombre": "calibrar", "ejercicio": "ankle_dorsiflexion_standing", "lado": "der"})
    eventos, t = correr_cuerpo(ctrl, [{}] * 70)  # vista y reposo
    subida = [{"cadera": c, "tobillo": a} for c, a in zip(rampa(0, 40), rampa(0, 25))] + [{"cadera": 40, "tobillo": 25}] * 12
    eventos, _ = correr_cuerpo(ctrl, subida + subida[::-1] + [{}] * 10, t0=t)
    assert "intento_calibracion" not in nombres(eventos)


def test_los_otros_ejercicios_no_vigilan_el_talon():
    ctrl = Controlador()
    iniciar(ctrl, meta=60)  # doblar la rodilla: el talón sube, y está bien
    eventos, t = correr_cuerpo(ctrl, [{}] * 30)
    eventos, _ = correr_cuerpo(ctrl, [{"rodilla": a} for a in rampa(0, 70) + rampa(70, 0)], t0=t)
    assert nombres(eventos) == ["rep_valida"]


def test_vigia_talon_ignora_una_lectura_suelta():
    vigia = VigiaTalon(0.15)
    for i in range(6):
        assert not vigia.levantado(i * PASO_MS, 3.0)
    assert not vigia.levantado(6 * PASO_MS, 2.0)  # un fotograma raro hacia arriba
    assert not vigia.levantado(7 * PASO_MS, 3.6)  # y otro hacia abajo: el piso no se mueve
    assert vigia.piso == 3.0


def test_vigia_talon_avisa_si_sigue_arriba_y_vuelve_a_bajar():
    vigia = VigiaTalon(0.15)
    for i in range(5):
        vigia.levantado(i * PASO_MS, 3.0)
    assert [vigia.levantado((5 + i) * PASO_MS, 2.5) for i in range(4)][-1]
    assert not [vigia.levantado((9 + i) * PASO_MS, 3.0) for i in range(4)][-1]


def test_vigia_talon_acepta_un_piso_nuevo_si_el_jugador_se_movio():
    vigia = VigiaTalon(0.15)
    for i in range(5):
        vigia.levantado(i * PASO_MS, 3.0)
    t, ultimo = 5 * PASO_MS, None
    while t < 6000:
        ultimo = vigia.levantado(t, 2.5)
        t += PASO_MS
    assert ultimo is False and vigia.piso == 2.5
    assert not vigia.levantado(t, None)  # sin talón visible no se afirma nada


def test_angulo_imposible_se_descarta():
    ctrl = Controlador()
    iniciar(ctrl, meta=60)
    t = preparar_vista(ctrl)
    eventos, extra, _ = correr(ctrl, [0.0, 0.0, 145.0, 145.0], t0=t)  # > 120 + 10
    assert nombres(eventos) == ["fuera_de_rango"]
    assert extra["rep"]["fuera_de_rango"] and extra["rep"]["angulo"] is None


def test_serie_completa_entrega_resumen():
    ctrl = Controlador()
    iniciar(ctrl, meta=50, repeticiones=2)
    t = preparar_vista(ctrl)
    una = rampa(0, 55) + rampa(55, 0)
    eventos, _, _ = correr(ctrl, una + una, t0=t)
    assert nombres(eventos) == ["rep_valida", "rep_valida", "serie_completa"]
    resumen = eventos[-1]["resumen"]
    assert resumen["tipo"] == "juego" and resumen["completo"]
    assert resumen["mejor"] == pytest.approx(55) and resumen["reposo"] == pytest.approx(0)
    assert ctrl.actividad is None


def test_extension_sentado_cuenta_hacia_abajo():
    ctrl = Controlador()
    iniciar(ctrl, ejercicio="knee_extension_seated", meta=10, repeticiones=1)
    _, _, t = correr(ctrl, [90.0] * 30, vista=SENTADO_DER)  # rodilla a 90° (≥ 80 arma el contador)
    eventos, _, _ = correr(ctrl, rampa(90, 12) + rampa(12, 65), vista=SENTADO_DER, t0=t)  # 12 ≤ 10 + 5; vuelve ≥ 60
    eventos = [e for e in eventos if e["nombre"] != "vista_ok"]
    assert nombres(eventos) == ["rep_valida", "serie_completa"]
    assert eventos[0]["angulo_pico"] == pytest.approx(12)
    assert eventos[-1]["resumen"]["mejor"] == pytest.approx(12)


def test_reposo_del_jugador_adapta_el_inicio():
    # Con una contractura la rodilla no baja de 25°: el inicio pasa a 35° en lugar de 10°.
    ctrl = Controlador()
    iniciar(ctrl, meta=70, reposo=25.0, repeticiones=1)
    t = preparar_vista(ctrl, angulo=25.0)
    eventos, _, _ = correr(ctrl, rampa(25, 68) + rampa(68, 25), t0=t)
    assert nombres(eventos) == ["rep_valida", "serie_completa"]


def test_meta_muy_cerca_del_inicio_se_rechaza():
    with pytest.raises(Exception, match="muy cerca"):
        crear_contador(cargar().ejercicios["knee_flexion_standing"], meta=40, tiempo_sostenido_ms=0, reposo=32)


@pytest.mark.parametrize("cambio", [
    {"ejercicio": "codo"}, {"lado": "centro"}, {"meta": 130}, {"meta": "90"}, {"repeticiones": 0},
])
def test_rechaza_comandos_invalidos(cambio):
    ctrl = Controlador()
    datos = {"nombre": "iniciar_ejercicio", "ejercicio": "knee_flexion_standing", "lado": "der", **cambio}
    [ev] = ctrl.comando(datos)
    assert ev["nombre"] == "comando_rechazado"


def test_sentado_exige_el_muslo_horizontal():
    # De perfil pero de pie (muslo vertical): aún no se ha sentado, no se mide el reposo.
    ctrl = Controlador()
    iniciar(ctrl, ejercicio="knee_extension_seated", meta=10)
    de_pie = {**LATERAL_DER, "muslo_horizontal": False}
    eventos, extra, t = correr(ctrl, [5.0] * 60, vista=de_pie)
    assert "vista_ok" not in nombres(eventos)
    assert extra["rep"]["fase"] == "verificando_vista"
    eventos, _, _ = correr(ctrl, [90.0] * 30, vista=SENTADO_DER, t0=t)
    assert "vista_ok" in nombres(eventos)


def test_sentado_deja_de_medir_si_se_gira_hacia_la_camara():
    ctrl = Controlador()
    iniciar(ctrl, ejercicio="knee_extension_seated", meta=10)
    _, _, t = correr(ctrl, [90.0] * 30, vista=SENTADO_DER)
    girado = {"lateral": False, "lado_camara": "der", "razon": 0.66, "muslo_horizontal": True}
    eventos, extra, t = correr(ctrl, [36.0] * 40, vista=girado, t0=t)
    assert nombres(eventos).count("vista_perdida") == 1
    assert extra["rep"]["fase"] == "verificando_vista"
    assert min(ctrl.actividad.angulos[-5:]) > 30  # lo medido mientras seguía de perfil no se borra
    n = len(ctrl.actividad.angulos)
    correr(ctrl, [36.0] * 20, vista=girado, t0=t)
    assert len(ctrl.actividad.angulos) == n  # girado no se mide
    eventos, extra, _ = correr(ctrl, [90.0] * 30, vista=SENTADO_DER, t0=t + 800)
    assert "vista_ok" in nombres(eventos)
    assert extra["rep"]["fase"] == "midiendo"


def test_una_lectura_suelta_no_interrumpe_al_sentado():
    ctrl = Controlador()
    iniciar(ctrl, ejercicio="knee_extension_seated", meta=10)
    _, _, t = correr(ctrl, [90.0] * 30, vista=SENTADO_DER)
    girado = {"lateral": False, "lado_camara": "der", "razon": 0.66, "muslo_horizontal": True}
    eventos, _, t = correr(ctrl, [90.0] * 10, vista=girado, t0=t)  # 0.4 s
    eventos2, extra, _ = correr(ctrl, [90.0] * 10, vista=SENTADO_DER, t0=t)
    assert "vista_perdida" not in nombres(eventos + eventos2)
    assert extra["rep"]["fase"] == "midiendo"


def test_de_pie_no_cambia_por_girarse_durante_la_medicion():
    ctrl = Controlador()
    iniciar(ctrl)
    t = preparar_vista(ctrl, angulo=2.0)
    eventos, extra, _ = correr(ctrl, [2.0] * 60, vista=FRONTAL, t0=t)
    assert "vista_perdida" not in nombres(eventos)
    assert extra["rep"]["fase"] == "midiendo"


def test_el_resumen_dice_que_pagina_pidio_la_actividad():
    ctrl = Controlador()
    ctrl.comando({"nombre": "calibrar", "ejercicio": "knee_flexion_standing", "lado": "der", "cliente": "pagina-a"})
    [ev] = ctrl.comando({"nombre": "detener"})
    assert ev["resumen"]["cliente"] == "pagina-a"
