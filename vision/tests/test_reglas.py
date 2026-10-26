import pytest

from app.controlador import Controlador, FiltroSaltos, crear_contador
from app.reglas import cargar

PASO_MS = 40  # ~25 FPS
LATERAL_DER = {"lateral": True, "lado_camara": "der", "razon": 0.05}
FRONTAL = {"lateral": False, "lado_camara": "der", "razon": 0.8}


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
    t = preparar_vista(ctrl, angulo=90.0)  # sentado: rodilla a 90° (≥ 80 arma el contador)
    eventos, _, _ = correr(ctrl, rampa(90, 12) + rampa(12, 65), t0=t)  # 12 ≤ 10 + 5; vuelve ≥ 60
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


# --- evaluación inicial de rango ---------------------------------------------------

def test_evaluacion_mide_el_rango_del_jugador():
    ctrl = Controlador()
    assert ctrl.comando({"nombre": "evaluar_rango", "ejercicio": "knee_flexion_standing",
                         "lado": "der", "duracion_ms": 4000}) == []
    t = preparar_vista(ctrl, angulo=4.0)
    intento = rampa(4, 47) + rampa(47, 4)
    eventos, _, _ = correr(ctrl, intento * 5, t0=t)
    assert nombres(eventos) == ["evaluacion_lista"]
    r = eventos[0]["resumen"]
    assert r["tipo"] == "evaluacion" and r["completo"]
    assert r["mejor"] == pytest.approx(47) and r["reposo"] == pytest.approx(4)
    assert r["rango"] == pytest.approx(43)


def test_evaluacion_excluye_compensaciones():
    ctrl = Controlador()
    ctrl.comando({"nombre": "evaluar_rango", "ejercicio": "knee_flexion_standing", "lado": "der",
                  "duracion_ms": 3000})
    t = preparar_vista(ctrl)
    eventos = []
    for a in rampa(0, 40, 40) + rampa(40, 0, 40):
        t += PASO_MS
        cadera = 30.0 if a > 35 else 0.0  # sobre 35° el jugador adelanta el muslo
        eventos += ctrl.procesar(t, {"rodilla_der": a, "cadera_der": cadera}, LATERAL_DER, 25.0)[1]
    final = [e for e in eventos if e["nombre"] == "evaluacion_lista"][0]["resumen"]
    assert final["mejor"] < 36 and final["compensaciones"] == 1


def test_evaluacion_sin_datos_falla():
    ctrl = Controlador()
    ctrl.comando({"nombre": "evaluar_rango", "ejercicio": "ankle_dorsiflexion_standing", "lado": "der",
                  "duracion_ms": 3000})
    preparar_vista(ctrl, clave="tobillo_der")
    eventos, _, _ = correr(ctrl, [None] * 100, clave="tobillo_der", t0=2000)
    assert nombres(eventos) == ["evaluacion_fallida"]
