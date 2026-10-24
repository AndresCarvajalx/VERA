import pytest

from app.calibracion import Calibrador, angulos_relativos
from app.controlador import Controlador
from app.repeticiones import ContadorRepeticiones

PASO_MS = 40  # ~25 FPS


def recorrer(contador, amplitudes, t0=0):
    """Pasa una serie de amplitudes (una por fotograma) y devuelve los eventos y el tiempo final."""
    eventos, t = [], t0
    for a in amplitudes:
        t += PASO_MS
        ev = contador.actualizar(t, a)
        if ev:
            eventos.append(ev)
    return eventos, t


def rampa(desde, hasta, pasos):
    return [desde + (hasta - desde) * i / (pasos - 1) for i in range(pasos)]


def sostener(valor, ms):
    return [valor] * (ms // PASO_MS)


# --- repeticiones --------------------------------------------------------------

def test_repeticion_valida_completa():
    c = ContadorRepeticiones(objetivo=40, tolerancia=5, tiempo_sostenido_ms=1000)
    serie = rampa(0, 42, 15) + sostener(42, 1200) + rampa(42, 0, 15)
    eventos, _ = recorrer(c, serie)
    assert eventos == ["rep_valida"]
    assert c.validas == 1
    assert c.repeticiones[0].angulo_pico == pytest.approx(42)
    assert c.estado == "reposo"


def test_no_sostener_el_tiempo_es_incompleta():
    c = ContadorRepeticiones(objetivo=40, tolerancia=5, tiempo_sostenido_ms=1000)
    serie = rampa(0, 42, 15) + sostener(42, 400) + rampa(42, 0, 15)
    assert recorrer(c, serie)[0] == ["rep_incompleta"]
    assert c.validas == 0


def test_no_llegar_al_objetivo_es_incompleta():
    c = ContadorRepeticiones(objetivo=40, tolerancia=5, tiempo_sostenido_ms=0)
    serie = rampa(0, 30, 15) + rampa(30, 0, 15)
    assert recorrer(c, serie)[0] == ["rep_incompleta"]
    assert c.repeticiones[0].angulo_pico == pytest.approx(30)


def test_la_tolerancia_cuenta_como_objetivo():
    c = ContadorRepeticiones(objetivo=40, tolerancia=5, tiempo_sostenido_ms=200)
    serie = rampa(0, 36, 10) + sostener(36, 400) + rampa(36, 0, 10)
    assert recorrer(c, serie)[0] == ["rep_valida"]


def test_temblor_en_el_umbral_no_cuenta_doble():
    c = ContadorRepeticiones(objetivo=40, tolerancia=5, tiempo_sostenido_ms=200)
    temblor = [35.5, 34.0, 35.8, 33.5, 35.2, 34.1] * 10  # oscila alrededor de 35 sin salir de la histéresis
    serie = rampa(0, 35, 10) + temblor + rampa(35, 0, 10)
    eventos, _ = recorrer(c, serie)
    assert eventos == ["rep_valida"]


def test_ruido_en_reposo_no_inicia_repeticion():
    c = ContadorRepeticiones(objetivo=40)
    eventos, _ = recorrer(c, [0, 3, -2, 4, 1, 2] * 20)
    assert eventos == [] and c.estado == "reposo" and not c.repeticiones


def test_varias_repeticiones():
    c = ContadorRepeticiones(objetivo=30, tolerancia=3, tiempo_sostenido_ms=500)
    una = rampa(0, 32, 10) + sostener(32, 600) + rampa(32, 0, 10)
    otra_corta = rampa(0, 20, 8) + rampa(20, 0, 8)
    eventos, _ = recorrer(c, una + otra_corta + una)
    assert eventos == ["rep_valida", "rep_incompleta", "rep_valida"]
    assert c.validas == 2


def test_fotogramas_sin_confianza_no_suman_tiempo():
    c = ContadorRepeticiones(objetivo=40, tolerancia=5, tiempo_sostenido_ms=1000)
    serie = rampa(0, 42, 10) + sostener(42, 400) + [None] * 50 + sostener(42, 400) + rampa(42, 0, 10)
    assert recorrer(c, serie)[0] == ["rep_incompleta"]  # 800 ms reales sostenidos < 1000


# --- calibración ---------------------------------------------------------------

def test_calibracion_quieto():
    cal = Calibrador(duracion_ms=1000)
    resultado = None
    for i in range(30):
        resultado = cal.agregar(i * 40, {"rodilla_der": 165 + (i % 3) * 0.5, "cadera_der": None}, True) or resultado
    assert resultado[0] == "lista"
    assert resultado[1]["rodilla_der"] == pytest.approx(165.5)
    assert "cadera_der" not in resultado[1]


def test_calibracion_con_movimiento_falla():
    cal = Calibrador(duracion_ms=1000)
    resultado = None
    for i in range(30):
        resultado = cal.agregar(i * 40, {"rodilla_der": 140 + i * 2}, True) or resultado
    assert resultado == ("fallida", "movimiento")


def test_calibracion_espera_el_encuadre():
    cal = Calibrador(duracion_ms=1000)
    for i in range(20):
        assert cal.agregar(i * 40, {"rodilla_der": 170}, False) is None
    assert cal.progreso(800) == 0


def test_angulos_relativos():
    rel = angulos_relativos({"rodilla_der": 120.0, "cadera_der": None, "tobillo_der": 100.0},
                            {"rodilla_der": 165.0, "cadera_der": 170.0})
    assert rel == {"rodilla_der": 45.0, "cadera_der": None, "tobillo_der": None}


# --- controlador ---------------------------------------------------------------

def calibrar(ctrl, angulo=170.0):
    ctrl.comando({"nombre": "calibrar"})
    eventos = []
    for i in range(70):
        eventos += ctrl.procesar(i * 40, {"rodilla_der": angulo}, True, 25.0)[1]
    return eventos


def test_no_inicia_sin_calibrar():
    ctrl = Controlador()
    [ev] = ctrl.comando({"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der", "objetivo": 40})
    assert ev["nombre"] == "comando_rechazado"


@pytest.mark.parametrize("cambio", [
    {"articulacion": "codo"}, {"lado": "centro"}, {"objetivo": 500}, {"objetivo": "40"},
    {"tolerancia": 50}, {"sentido": 0},
])
def test_rechaza_parametros_invalidos(cambio):
    ctrl = Controlador()
    calibrar(ctrl)
    comando = {"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der", "objetivo": 40, **cambio}
    [ev] = ctrl.comando(comando)
    assert ev["nombre"] == "comando_rechazado"


def test_flujo_completo_de_una_serie():
    ctrl = Controlador()
    assert calibrar(ctrl)[0] == {"nombre": "calibracion_lista", "neutros": {"rodilla_der": 170.0}}
    assert ctrl.comando({"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der",
                         "objetivo": 40, "tolerancia": 5, "tiempo_sostenido_ms": 400, "repeticiones": 2}) == []
    flexion = rampa(170, 128, 10) + [128] * 15 + rampa(128, 170, 10)  # 42° de amplitud
    eventos, t = [], 10_000
    for angulo in flexion * 2:
        t += 40
        extra, ev = ctrl.procesar(t, {"rodilla_der": angulo}, True, 25.0)
        eventos += ev
    nombres = [e["nombre"] for e in eventos]
    assert nombres == ["rep_valida", "rep_valida", "serie_completa"]
    resumen = eventos[-1]["resumen"]
    assert resumen["validas"] == 2 and resumen["amplitud_max"] == pytest.approx(42)
    assert resumen["neutro"] == 170.0
    assert ctrl.ejercicio is None


def test_sin_ver_la_pierna_el_reto_espera():
    ctrl = Controlador()
    calibrar(ctrl)
    ctrl.comando({"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der", "objetivo": 40})
    extra, _ = ctrl.procesar(20_000, {"rodilla_der": None}, True, 25.0)
    assert extra["rep"]["estado"] == "no_visible"
    assert ctrl.ejercicio.contador.estado == "reposo"


def test_cuerpo_incompleto_no_pausa_si_se_ve_la_pierna():
    # Antes un pie fuera de cuadro pausaba el reto aunque la rodilla se midiera bien.
    ctrl = Controlador()
    calibrar(ctrl)
    ctrl.comando({"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der", "objetivo": 40})
    extra, _ = ctrl.procesar(20_000, {"rodilla_der": 150.0}, False, 25.0)  # 20° de 40
    assert extra["rep"]["estado"] == "subiendo"


def test_recalibrar_cierra_el_ejercicio_en_curso():
    ctrl = Controlador()
    calibrar(ctrl)
    ctrl.comando({"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der", "objetivo": 40})
    [ev] = ctrl.comando({"nombre": "calibrar"})
    assert ev["nombre"] == "ejercicio_detenido"
    assert ctrl.ejercicio is None and ctrl.calibrando


def test_extension_desde_sentado_con_sentido_negativo():
    ctrl = Controlador()
    calibrar(ctrl, angulo=95.0)  # sentado: rodilla a ~95°
    ctrl.comando({"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der", "objetivo": 30,
                  "tolerancia": 5, "tiempo_sostenido_ms": 200, "sentido": -1, "repeticiones": 1})
    estirar = rampa(95, 130, 10) + [130] * 8 + rampa(130, 95, 10)  # abre la rodilla 35°
    eventos, t = [], 10_000
    for angulo in estirar:
        t += 40
        eventos += ctrl.procesar(t, {"rodilla_der": angulo}, True, 25.0)[1]
    assert [e["nombre"] for e in eventos] == ["rep_valida", "serie_completa"]


def test_detener_entrega_resumen():
    ctrl = Controlador()
    calibrar(ctrl)
    ctrl.comando({"nombre": "iniciar_ejercicio", "articulacion": "rodilla", "lado": "der", "objetivo": 40})
    [ev] = ctrl.comando({"nombre": "detener"})
    assert ev["nombre"] == "ejercicio_detenido" and ev["resumen"]["intentadas"] == 0
