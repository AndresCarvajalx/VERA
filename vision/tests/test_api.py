import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool

from api import bd
from api.rutas import rutas


@pytest.fixture
def cliente():
    # Base de datos en memoria, nueva para cada prueba.
    bd.iniciar("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    app = FastAPI()
    app.include_router(rutas, prefix="/api")
    return TestClient(app)


def crear_jugador(cliente, codigo="AMC-001"):
    r = cliente.post("/api/pacientes", json={"codigo": codigo, "version_consentimiento": "v1",
                                             "autoriza_datos_sensibles": True})
    assert r.status_code == 201, r.text


def resultado(tipo="juego", mejor=50.0, reposo=2.0, ejercicio="knee_flexion_standing", **extra):
    return {"tipo": tipo, "ejercicio": ejercicio, "lado": "der", "meta": 90 if tipo == "juego" else None,
            "angulo_max": mejor, "angulo_min": reposo, "rango": mejor - reposo, "mejor": mejor,
            "reposo": reposo, "validas": 3, "intentadas": 4, "compensaciones": 1, "completo": True,
            "fps_promedio": 24.0,
            "repeticiones": [{"numero": 1, "angulo_pico": mejor, "sostenido_ms": 300, "valida": True}], **extra}


def test_catalogo_viene_de_las_reglas(cliente):
    ejercicios = {e["clave"]: e for e in cliente.get("/api/ejercicios").json()}
    assert len(ejercicios) == 4
    assert ejercicios["hip_flexion_standing"]["max_fisiologico"] == 120


def test_jugador_requiere_codigo_anonimo_y_consentimiento(cliente):
    sin_permiso = {"codigo": "AMC-002", "version_consentimiento": "v1", "autoriza_datos_sensibles": False}
    assert cliente.post("/api/pacientes", json=sin_permiso).status_code == 422
    nombre = {"codigo": "Brayan Gutierrez", "version_consentimiento": "v1", "autoriza_datos_sensibles": True}
    assert cliente.post("/api/pacientes", json=nombre).status_code == 422  # espacios: parece un nombre
    crear_jugador(cliente)
    assert cliente.post("/api/pacientes", json={**nombre, "codigo": "AMC-001"}).status_code == 409
    assert cliente.get("/api/pacientes").json() == ["AMC-001"]
    assert cliente.get("/api/pacientes/AMC-001").json()["consentimiento_vigente"]


def test_meta_por_encima_del_limite_se_rechaza(cliente):
    crear_jugador(cliente)
    objetivo = {"ejercicio": "knee_flexion_standing", "lado": "der", "meta": 130, "repeticiones": 5,
                "tiempo_sostenido_ms": 0, "aprobado_por": "Ft. Pérez"}
    assert cliente.put("/api/pacientes/AMC-001/objetivos", json=objetivo).status_code == 422
    assert cliente.put("/api/pacientes/AMC-001/objetivos", json={**objetivo, "meta": 60}).status_code == 200
    assert cliente.put("/api/pacientes/AMC-001/objetivos", json={**objetivo, "meta": 70}).status_code == 200
    objetivos = cliente.get("/api/pacientes/AMC-001").json()["objetivos"]
    assert [o["meta"] for o in objetivos] == [70]  # solo queda vigente la última


def calibracion(mejor, reposo=2.0, ejercicio="knee_flexion_standing", **extra):
    datos = {"repeticiones": [], "validas": None, "intentadas": None, "intentos": [mejor - 1, mejor, mejor + 1],
             "dispersion": 2.0, "consistente": True, **extra}
    return resultado("calibracion", mejor=mejor, reposo=reposo, ejercicio=ejercicio, **datos)


def nueva_sesion(cliente):
    return cliente.post("/api/sesiones", json={"paciente": "AMC-001"}).json()["id"]


def guardar(cliente, sesion, datos):
    r = cliente.post(f"/api/sesiones/{sesion}/resultados", json=datos)
    assert r.status_code == 201, r.text


def test_progreso_por_calibraciones_de_cada_sesion(cliente):
    crear_jugador(cliente)
    for mejor_cal, partidas in ((40.0, [48.0, 50.0]), (47.0, [52.0]), (55.5, [])):
        sesion = nueva_sesion(cliente)
        guardar(cliente, sesion, calibracion(mejor_cal))
        for mejor in partidas:
            guardar(cliente, sesion, resultado(mejor=mejor, meta=36))
        cliente.patch(f"/api/sesiones/{sesion}", json={"latencia_promedio_ms": 52})

    [serie] = cliente.get("/api/pacientes/AMC-001/progreso").json()
    # El progreso es el rango calibrado por sesión, no el mejor fotograma de las partidas.
    assert [p["mejor"] for p in serie["puntos"]] == [40.0, 47.0, 55.5]
    assert serie["inicial"]["mejor"] == 40.0 and serie["mejora"] == 15.5
    assert [p["partidas"] for p in serie["puntos"]] == [2, 1, 0]
    assert serie["puntos"][0]["validas"] == 6 and serie["puntos"][0]["intentadas"] == 8
    assert serie["referencia"] == 120 and serie["faltante_referencia"] == 64.5
    assert serie["meta"] == 36
    assert serie["puntos"][0]["fecha"].endswith("+00:00")


def test_varias_calibraciones_en_una_sesion_son_un_solo_punto(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    for mejor in (50.0, 24.0, 44.0):
        guardar(cliente, sesion, calibracion(mejor))
    [serie] = cliente.get("/api/pacientes/AMC-001/progreso").json()
    assert [p["mejor"] for p in serie["puntos"]] == [44.0]  # la última de la sesión


def test_progreso_de_extension_mejora_al_bajar(cliente):
    crear_jugador(cliente)
    for mejor in (35.0, 22.0):
        guardar(cliente, nueva_sesion(cliente), calibracion(mejor, reposo=90.0, ejercicio="knee_extension_seated"))
    [serie] = cliente.get("/api/pacientes/AMC-001/progreso").json()
    assert serie["mejora"] == 13.0  # 35° → 22° de flexión restante: 13° más recta
    assert serie["referencia"] == 0 and serie["faltante_referencia"] == 22.0


def test_intentos_de_calibracion_se_guardan(cliente):
    crear_jugador(cliente)
    guardar(cliente, nueva_sesion(cliente), calibracion(40.0))
    from api.bd import _fabrica
    from api.modelos import Repeticion
    with _fabrica() as bd:
        assert sorted(r.angulo_pico for r in bd.query(Repeticion).filter_by(motivo="intento")) == [39, 40, 41]


# --- plan adaptado -------------------------------------------------------------

def pedir_plan(cliente, sesion, ejercicio="knee_flexion_standing"):
    params = {"ejercicio": ejercicio, "lado": "der", **({"sesion": sesion} if sesion else {})}
    return cliente.get("/api/pacientes/AMC-001/plan", params=params).json()


def test_sin_calibrar_en_la_sesion_no_hay_plan(cliente):
    crear_jugador(cliente)
    anterior = nueva_sesion(cliente)
    guardar(cliente, anterior, calibracion(60.0))
    hoy = nueva_sesion(cliente)
    assert pedir_plan(cliente, hoy)["requiere_calibracion"]  # la calibración de otro día no sirve
    assert pedir_plan(cliente, None)["requiere_calibracion"]


def test_meta_sale_de_la_calibracion(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    guardar(cliente, sesion, calibracion(62.0, reposo=2.0))
    plan = pedir_plan(cliente, sesion)
    assert not plan["requiere_calibracion"] and plan["origen"] == "calibracion"
    assert plan["meta"] == 56  # 2 + 0.9 · (62 − 2)
    assert plan["reposo"] == 2.0 and plan["repeticiones"] == 5 and plan["jugable"]


def test_meta_sube_si_lo_logra_y_baja_si_no(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    guardar(cliente, sesion, calibracion(62.0))
    guardar(cliente, sesion, resultado(mejor=60.0, validas=5, intentadas=5, meta=56))
    assert pedir_plan(cliente, sesion)["meta"] == 59
    guardar(cliente, sesion, resultado(mejor=60.0, validas=5, intentadas=5, meta=59))
    assert pedir_plan(cliente, sesion)["meta"] == 62
    guardar(cliente, sesion, resultado(mejor=60.0, validas=1, intentadas=5, meta=62))
    assert pedir_plan(cliente, sesion)["meta"] == 59


def test_meta_nunca_pasa_lo_calibrado_mas_el_margen(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    guardar(cliente, sesion, calibracion(62.0))
    for _ in range(10):
        guardar(cliente, sesion, resultado(mejor=70.0, validas=5, intentadas=5))
    assert pedir_plan(cliente, sesion)["meta"] == 72  # 62 + 10 de margen


def test_meta_nunca_pasa_el_limite_fisiologico(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    guardar(cliente, sesion, calibracion(118.0))
    for _ in range(10):
        guardar(cliente, sesion, resultado(mejor=118.0, validas=5, intentadas=5))
    assert pedir_plan(cliente, sesion)["meta"] == 120


def test_meta_del_fisioterapeuta_tiene_prioridad(cliente):
    crear_jugador(cliente)
    cliente.put("/api/pacientes/AMC-001/objetivos", json={
        "ejercicio": "knee_flexion_standing", "lado": "der", "meta": 45, "repeticiones": 5,
        "tiempo_sostenido_ms": 0, "aprobado_por": "Ft. Pérez"})
    sesion = nueva_sesion(cliente)
    guardar(cliente, sesion, calibracion(62.0))
    plan = pedir_plan(cliente, sesion)
    assert plan["meta"] == 45 and plan["origen"] == "fisioterapeuta"


def test_extension_sentado_meta_hacia_abajo(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    guardar(cliente, sesion, calibracion(30.0, reposo=90.0, ejercicio="knee_extension_seated"))
    plan = pedir_plan(cliente, sesion, "knee_extension_seated")
    assert plan["meta"] == 36  # 90 − 0.9 · (90 − 30)
    assert plan["direccion"] == "abajo" and plan["referencia"] == 0


def test_rango_muy_pequeno_no_es_jugable(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    guardar(cliente, sesion, calibracion(14.0, reposo=2.0))  # inicio 12 + tolerancias > 14
    assert not pedir_plan(cliente, sesion)["jugable"]


def test_sesion_cerrada_no_acepta_resultados(cliente):
    crear_jugador(cliente)
    sesion = cliente.post("/api/sesiones", json={"paciente": "AMC-001"}).json()["id"]
    cliente.patch(f"/api/sesiones/{sesion}", json={})
    assert cliente.post(f"/api/sesiones/{sesion}/resultados", json=resultado()).status_code == 409


def test_migra_una_base_de_la_version_anterior(tmp_path):
    import sqlite3
    archivo = tmp_path / "vieja.sqlite3"
    con = sqlite3.connect(archivo)
    con.executescript("""
        CREATE TABLE resultado_ejercicio (id INTEGER PRIMARY KEY, sesion_id INTEGER, ejercicio_clave VARCHAR,
            lado VARCHAR, tipo VARCHAR, meta FLOAT, angulo_max FLOAT, angulo_min FLOAT, rango FLOAT, mejor FLOAT,
            reposo FLOAT, validas INTEGER, intentadas INTEGER, compensaciones INTEGER, completo BOOLEAN,
            fps_promedio FLOAT, fecha DATETIME);
        INSERT INTO resultado_ejercicio (id, tipo, mejor) VALUES (1, 'evaluacion', 50.2), (2, 'juego', 47.4);
    """)
    con.commit(); con.close()
    bd.iniciar(f"sqlite:///{archivo.as_posix()}")
    con = sqlite3.connect(archivo)
    columnas = {fila[1] for fila in con.execute("PRAGMA table_info(resultado_ejercicio)")}
    assert {"dispersion", "consistente"} <= columnas
    assert con.execute("SELECT tipo, mejor, consistente FROM resultado_ejercicio ORDER BY id").fetchall() == [
        ("calibracion", 50.2, None), ("juego", 47.4, None)]
    con.close()


def test_evaluaciones_antiguas_no_entran_al_progreso(cliente):
    crear_jugador(cliente)
    guardar(cliente, nueva_sesion(cliente), calibracion(44.0, consistente=None, dispersion=None))
    guardar(cliente, nueva_sesion(cliente), calibracion(113.7))
    [serie] = cliente.get("/api/pacientes/AMC-001/progreso").json()
    assert [p["mejor"] for p in serie["puntos"]] == [113.7] and serie["mejora"] == 0


def medir(cliente, sesion, gonio, sistema, articulacion="rodilla", dispersion=1.0):
    return cliente.post(f"/api/sesiones/{sesion}/mediciones-referencia", json={
        "articulacion": articulacion, "lado": "der", "angulo_goniometro": gonio, "angulo_sistema": sistema,
        "dispersion_sistema": dispersion, "evaluador": "Ft. Pérez"})


def test_precision_frente_al_goniometro(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    for gonio, sistema in ((30, 34), (60, 57), (90, 96)):
        assert medir(cliente, sesion, gonio, sistema).status_code == 201
    assert medir(cliente, sesion, 10, 12, articulacion="tobillo").status_code == 201
    p = cliente.get("/api/pacientes/AMC-001/precision").json()
    rodilla = p["por_articulacion"]["rodilla"]
    assert rodilla["n"] == 3
    assert rodilla["error_absoluto_medio"] == pytest.approx(4.3, abs=0.05)  # (4 + 3 + 6) / 3
    assert rodilla["sesgo"] == pytest.approx(2.3, abs=0.05) and rodilla["error_maximo"] == 6
    assert rodilla["cumple_meta"] and p["meta"] == 10
    assert p["total"]["n"] == 4 and len(p["mediciones"]) == 4


def test_medicion_inestable_se_rechaza(cliente):
    crear_jugador(cliente)
    sesion = nueva_sesion(cliente)
    assert medir(cliente, sesion, 30, 34, dispersion=6.0).status_code == 422  # el jugador se movía


def test_precision_sin_mediciones(cliente):
    crear_jugador(cliente)
    assert cliente.get("/api/pacientes/AMC-001/precision").json()["total"] is None


def test_jugador_inexistente(cliente):
    assert cliente.post("/api/sesiones", json={"paciente": "NADIE"}).status_code == 404
    assert cliente.get("/api/pacientes/NADIE/progreso").status_code == 404
