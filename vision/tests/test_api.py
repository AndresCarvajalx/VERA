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


def test_guardar_resultados_y_ver_progreso(cliente):
    crear_jugador(cliente)
    sesion = cliente.post("/api/sesiones", json={"paciente": "AMC-001"}).json()["id"]
    assert cliente.post(f"/api/sesiones/{sesion}/resultados",
                        json=resultado("evaluacion", mejor=40.0)).status_code == 201
    assert cliente.post(f"/api/sesiones/{sesion}/resultados", json=resultado(mejor=48.0)).status_code == 201
    assert cliente.post(f"/api/sesiones/{sesion}/resultados", json=resultado(mejor=55.5)).status_code == 201
    assert cliente.patch(f"/api/sesiones/{sesion}", json={"latencia_promedio_ms": 52}).status_code == 200

    [serie] = cliente.get("/api/pacientes/AMC-001/progreso").json()
    assert serie["inicial"]["mejor"] == 40.0 and serie["inicial"]["tipo"] == "evaluacion"
    assert [p["mejor"] for p in serie["puntos"]] == [40.0, 48.0, 55.5]
    assert serie["mejora"] == 15.5
    assert serie["referencia"] == 120 and serie["faltante_referencia"] == 64.5
    assert serie["meta"] == 90 and not serie["meta_aprobada"]
    assert serie["puntos"][0]["fecha"].endswith("+00:00")


def test_progreso_de_extension_mejora_al_bajar(cliente):
    crear_jugador(cliente)
    sesion = cliente.post("/api/sesiones", json={"paciente": "AMC-001"}).json()["id"]
    for tipo, mejor in (("evaluacion", 35.0), ("juego", 22.0)):
        cliente.post(f"/api/sesiones/{sesion}/resultados",
                     json=resultado(tipo, mejor=mejor, reposo=90.0, ejercicio="knee_extension_seated"))
    [serie] = cliente.get("/api/pacientes/AMC-001/progreso").json()
    assert serie["mejora"] == 13.0  # 35° → 22° de flexión restante: 13° más recta
    assert serie["referencia"] == 0 and serie["faltante_referencia"] == 22.0


def test_sesion_cerrada_no_acepta_resultados(cliente):
    crear_jugador(cliente)
    sesion = cliente.post("/api/sesiones", json={"paciente": "AMC-001"}).json()["id"]
    cliente.patch(f"/api/sesiones/{sesion}", json={})
    assert cliente.post(f"/api/sesiones/{sesion}/resultados", json=resultado()).status_code == 409


def test_jugador_inexistente(cliente):
    assert cliente.post("/api/sesiones", json={"paciente": "NADIE"}).status_code == 404
    assert cliente.get("/api/pacientes/NADIE/progreso").status_code == 404
