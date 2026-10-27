import pytest

from app.calibracion import Calibracion
from app.controlador import Controlador
from app.reglas import cargar
from tests.test_reglas import LATERAL_DER, PASO_MS, correr, nombres, rampa

P = cargar().calibracion  # reposo 1 s, umbral 8°, sostenido 200 ms, 3 intentos, dispersión ≤ 8°


def quieto(valor, ms):
    return [valor] * (ms // PASO_MS)


def intento(reposo, pico, sostener_ms=400, pasos=10):
    """Sube del reposo al pico, lo mantiene y vuelve."""
    return rampa(reposo, pico, pasos) + quieto(pico, sostener_ms) + rampa(pico, reposo, pasos)


def pasar(cal, valores, t0=0):
    t, resultado = t0, None
    for v in valores:
        t += PASO_MS
        resultado = cal.actualizar(t, v) or resultado
        if resultado:
            break
    return resultado, t


# --- algoritmo ------------------------------------------------------------------

def test_mide_reposo_e_intentos_coherentes():
    cal = Calibracion(P, signo=1)
    serie = quieto(5, 1200) + intento(5, 60) + intento(5, 62) + intento(5, 58)
    resultado, _ = pasar(cal, serie)
    assert resultado[0] == "lista"
    r = resultado[1]
    assert r["reposo"] == pytest.approx(5)
    assert r["mejor"] == pytest.approx(60)  # mediana de 58, 60, 62
    assert r["rango"] == pytest.approx(55)
    assert r["consistente"] and r["dispersion"] == pytest.approx(4)
    assert r["intentos"] == [60, 62, 58]


def test_un_pico_de_un_fotograma_no_cuenta():
    # Un fotograma suelto a 95° (ruido del estimador) no puede inflar el rango calibrado.
    cal = Calibracion(P, signo=1)
    con_pico = rampa(5, 50, 10) + [95.0] + quieto(50, 400) + rampa(50, 5, 10)
    resultado, _ = pasar(cal, quieto(5, 1200) + con_pico + intento(5, 51) + intento(5, 49))
    assert resultado[1]["mejor"] == pytest.approx(50)


def test_moverse_en_el_reposo_vuelve_a_medirlo():
    cal = Calibracion(P, signo=1)
    pasar(cal, [5, 20, 5, 25, 5, 20] * 10)  # 2.4 s moviéndose
    assert cal.fase == "reposo"
    pasar(cal, quieto(5, 1200), t0=3000)
    assert cal.fase == "intentos" and cal.reposo_v == pytest.approx(5)


def test_contractura_reposo_lejos_de_cero():
    # Rodilla que no se estira más de 30°: el rango se mide desde su propio reposo.
    cal = Calibracion(P, signo=1)
    resultado, _ = pasar(cal, quieto(30, 1200) + intento(30, 55) * 3)
    assert resultado[1]["reposo"] == pytest.approx(30)
    assert resultado[1]["mejor"] == pytest.approx(55)


def test_intentos_incoherentes_piden_mas_y_se_marcan():
    cal = Calibracion(P, signo=1)
    picos = [40, 70, 52, 85, 60]  # nunca tres dentro de 8°
    serie = quieto(5, 1200) + [a for p in picos for a in intento(5, p)]
    resultado, _ = pasar(cal, serie)
    r = resultado[1]
    assert len(r["intentos"]) == 5 and not r["consistente"]
    assert r["mejor"] == pytest.approx(70)  # mediana de los tres mejores: 85, 70, 60


def test_ejercicio_hacia_abajo():
    # Estirar la rodilla sentado: reposo a 90°, mejor = el ángulo más bajo alcanzado.
    cal = Calibracion(P, signo=-1)
    serie = quieto(-90, 1200) + [a for p in (-30, -28, -32) for a in intento(-90, p)]
    resultado, _ = pasar(cal, [-v for v in serie])
    r = resultado[1]
    assert r["reposo"] == pytest.approx(90) and r["mejor"] == pytest.approx(30)
    assert r["rango"] == pytest.approx(60)


def test_sin_intentos_falla_por_tiempo():
    cal = Calibracion(P, signo=1)
    resultado, _ = pasar(cal, quieto(5, P.tiempo_max_ms + 200))
    assert resultado == ("fallida", "sin_intentos")


# --- integración con el controlador -----------------------------------------------

def test_controlador_calibra_y_entrega_resumen():
    ctrl = Controlador()
    assert ctrl.comando({"nombre": "calibrar", "ejercicio": "knee_flexion_standing", "lado": "der"}) == []
    eventos, extra, t = correr(ctrl, quieto(4.0, 1100))  # vista_ok
    eventos2, extra, t = correr(ctrl, quieto(4.0, 1200), t0=t)  # reposo
    assert extra["calibracion"]["paso"] == "intentos"
    eventos3, _, _ = correr(ctrl, intento(4, 47) + intento(4, 45) + intento(4, 49), t0=t)
    todos = nombres(eventos + eventos2 + eventos3)
    assert todos == ["vista_ok", "reposo_listo", "intento_calibracion", "intento_calibracion",
                     "intento_calibracion", "calibracion_lista"]
    r = eventos3[-1]["resumen"]
    assert r["tipo"] == "calibracion" and r["completo"] and r["consistente"]
    assert r["mejor"] == pytest.approx(47) and r["reposo"] == pytest.approx(4)
    assert ctrl.actividad is None


def test_compensacion_no_cuenta_en_la_calibracion():
    ctrl = Controlador()
    ctrl.comando({"nombre": "calibrar", "ejercicio": "knee_flexion_standing", "lado": "der"})
    _, _, t = correr(ctrl, quieto(0.0, 2400))
    eventos = []
    for pico in (40, 41, 39, 70, 72):  # los dos últimos adelantando el muslo 30°
        for a in intento(0, pico):
            t += PASO_MS
            cadera = 30.0 if pico > 60 and a > 45 else 0.0
            eventos += ctrl.procesar(t, {"rodilla_der": a, "cadera_der": cadera}, LATERAL_DER, 25.0)[1]
    final = [e for e in eventos if e["nombre"] == "calibracion_lista"][0]["resumen"]
    assert final["mejor"] == pytest.approx(40)  # termina con los 3 coherentes, sin los compensados


DATOS = __import__("pathlib").Path(__file__).parent / "datos"


def calibrar_traza(nombre):
    from app import trazas
    cal = Calibracion(P, signo=1)
    for t, angulo in trazas.leer(DATOS / nombre):
        resultado = cal.actualizar(t, angulo)
        if resultado:
            return resultado
    return None


def test_real_empezar_con_la_rodilla_doblada_se_corrige():
    # Traza real (solo ángulos): el jugador empezó 1 s quieto con la rodilla a ~108°, imitando a
    # la guía; la pierna recta estaba en 0–7° y las flexiones máximas en 114–118°.
    estado, r = calibrar_traza("real_rodilla_reposo_doblado.csv")
    assert estado == "lista" and r["reanclajes"] >= 1
    assert r["reposo"] < 8
    assert 112 <= r["mejor"] <= 118 and r["consistente"]


def test_real_dos_calibraciones_son_repetibles():
    _, a = calibrar_traza("real_rodilla_reposo_doblado.csv")
    _, b = calibrar_traza("real_rodilla_normal.csv")
    assert b["reposo"] < 8 and b["consistente"]
    assert abs(a["mejor"] - b["mejor"]) <= 5  # antes, con la evaluación por tiempo: 50° vs 24°


def test_traza_se_guarda_y_se_puede_reanalizar(tmp_path):
    from app import trazas
    from herramientas.analizar_calibraciones import analizar_traza
    cal = Calibracion(P, signo=1)
    resultado, _ = pasar(cal, quieto(5, 1200) + [None, None] + intento(5, 60) + intento(5, 61) + intento(5, 59))
    ruta = trazas.guardar("knee_flexion_standing", "der", cal.traza, resultado[1], directorio=tmp_path)
    assert trazas.leer(ruta) == [(t - cal.traza[0][0], a) for t, a in cal.traza]
    informe = analizar_traza(ruta)
    assert informe["mejor"] == pytest.approx(60) and informe["recalculado"] == pytest.approx(60)
    assert informe["sospechosos"] == 0 and informe["sin_medida"] > 0


def test_detener_calibracion_no_es_completa():
    ctrl = Controlador()
    ctrl.comando({"nombre": "calibrar", "ejercicio": "knee_flexion_standing", "lado": "der"})
    correr(ctrl, quieto(0.0, 600))
    [ev] = ctrl.comando({"nombre": "detener"})
    assert ev["nombre"] == "ejercicio_detenido" and not ev["resumen"]["completo"]
    assert ev["resumen"]["mejor"] is None
