"""Rutas REST de la API de datos: catálogo, jugadores, metas, sesiones, resultados y progreso."""
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.reglas import cargar

from .bd import sesion_bd
from .modelos import (Consentimiento, Ejercicio, ObjetivoAngular, Paciente, Repeticion, ResultadoEjercicio,
                      Sesion, ahora)

rutas = APIRouter()
CODIGO = re.compile(r"^[A-Za-z0-9-]{3,20}$")
Lado = str  # "izq" o "der", validado con pattern en los esquemas


# --- esquemas -----------------------------------------------------------------
class NuevoPaciente(BaseModel):
    codigo: str = Field(pattern=CODIGO.pattern, description="Código anónimo, p. ej. AMC-001. Nunca el nombre.")
    version_consentimiento: str = Field(min_length=1, max_length=20)
    autoriza_datos_sensibles: bool


class NuevoObjetivo(BaseModel):
    ejercicio: str
    lado: Lado = Field(pattern="^(izq|der)$")
    meta: float
    repeticiones: int = Field(ge=1, le=50)
    tiempo_sostenido_ms: int = Field(ge=0, le=30000)
    aprobado_por: str = Field(min_length=1, max_length=80)


class NuevaSesion(BaseModel):
    paciente: str


class CierreSesion(BaseModel):
    latencia_promedio_ms: float | None = None


class RepeticionEntrada(BaseModel):
    numero: int
    angulo_pico: float
    sostenido_ms: int
    valida: bool
    motivo: str | None = None


class ResultadoEntrada(BaseModel):
    """El resumen que el servicio de visión envía al terminar una evaluación o un ejercicio."""
    tipo: str = Field(pattern="^(evaluacion|juego)$")
    ejercicio: str
    lado: Lado = Field(pattern="^(izq|der)$")
    meta: float | None = None
    angulo_max: float | None = None
    angulo_min: float | None = None
    rango: float | None = None
    mejor: float | None = None
    reposo: float | None = None
    validas: int | None = None
    intentadas: int | None = None
    compensaciones: int = 0
    completo: bool
    fps_promedio: float | None = None
    repeticiones: list[RepeticionEntrada] = []


# --- utilidades ---------------------------------------------------------------
def _iso(fecha: datetime) -> str:
    """SQLite devuelve las fechas sin zona; se guardaron en UTC y así se informan al navegador."""
    return (fecha if fecha.tzinfo else fecha.replace(tzinfo=timezone.utc)).isoformat()


def _paciente(bd: Session, codigo: str) -> Paciente:
    paciente = bd.scalar(select(Paciente).where(Paciente.codigo == codigo)
                         .options(selectinload(Paciente.consentimientos)))
    if not paciente:
        raise HTTPException(404, f"No existe el jugador {codigo}")
    return paciente


def _regla(clave: str):
    regla = cargar().ejercicios.get(clave)
    if not regla:
        raise HTTPException(422, f"Ejercicio desconocido: {clave}")
    return regla


def _objetivos_vigentes(bd: Session, paciente_id: int) -> list[ObjetivoAngular]:
    return list(bd.scalars(select(ObjetivoAngular).where(
        ObjetivoAngular.paciente_id == paciente_id, ObjetivoAngular.vigente)))


def _objetivo_json(o: ObjetivoAngular) -> dict:
    return {"ejercicio": o.ejercicio_clave, "lado": o.lado, "meta": o.meta, "repeticiones": o.repeticiones,
            "tiempo_sostenido_ms": o.tiempo_sostenido_ms, "aprobado_por": o.aprobado_por,
            "fecha": _iso(o.fecha)}


# --- catálogo y jugadores -----------------------------------------------------
@rutas.get("/ejercicios")
def ejercicios(bd: Session = Depends(sesion_bd)) -> list[dict]:
    reglas = cargar()
    en_bd = {e.clave: e for e in bd.scalars(select(Ejercicio))}
    return [  # en el orden del archivo de reglas
        {"clave": e.clave, "nombre": e.nombre, "descripcion": reglas.ejercicios[e.clave].descripcion,
         "articulacion": e.articulacion, "posicion": e.posicion, "direccion": e.direccion,
         "meta_por_defecto": e.meta_por_defecto, "max_fisiologico": e.max_fisiologico,
         "min_fisiologico": e.min_fisiologico}
        for e in (en_bd[clave] for clave in reglas.ejercicios if clave in en_bd)
    ]


@rutas.get("/pacientes")
def pacientes(bd: Session = Depends(sesion_bd)) -> list[str]:
    return list(bd.scalars(select(Paciente.codigo).order_by(Paciente.codigo)))


@rutas.post("/pacientes", status_code=201)
def crear_paciente(datos: NuevoPaciente, bd: Session = Depends(sesion_bd)) -> dict:
    if not datos.autoriza_datos_sensibles:
        raise HTTPException(422, "Sin autorización de datos sensibles no se pueden guardar sesiones")
    if bd.scalar(select(Paciente).where(Paciente.codigo == datos.codigo)):
        raise HTTPException(409, f"Ya existe el jugador {datos.codigo}")
    paciente = Paciente(codigo=datos.codigo)
    paciente.consentimientos.append(Consentimiento(
        version_texto=datos.version_consentimiento, autoriza_datos_sensibles=True))
    bd.add(paciente)
    bd.commit()
    return {"codigo": paciente.codigo}


@rutas.get("/pacientes/{codigo}")
def ver_paciente(codigo: str, bd: Session = Depends(sesion_bd)) -> dict:
    paciente = _paciente(bd, codigo)
    return {"codigo": paciente.codigo, "consentimiento_vigente": paciente.consentimiento_vigente,
            "objetivos": [_objetivo_json(o) for o in _objetivos_vigentes(bd, paciente.id)]}


@rutas.put("/pacientes/{codigo}/objetivos")
def fijar_objetivo(codigo: str, datos: NuevoObjetivo, bd: Session = Depends(sesion_bd)) -> dict:
    paciente = _paciente(bd, codigo)
    regla = _regla(datos.ejercicio)
    if not regla.meta_valida(datos.meta):
        limite = regla.max_fisiologico if regla.direccion == "arriba" else regla.min_fisiologico
        raise HTTPException(422, f"La meta {datos.meta}° no es válida para «{regla.nombre}» "
                                 f"(límite de referencia {limite}°)")
    for anterior in _objetivos_vigentes(bd, paciente.id):
        if anterior.ejercicio_clave == datos.ejercicio and anterior.lado == datos.lado:
            anterior.vigente = False
    objetivo = ObjetivoAngular(
        paciente_id=paciente.id, ejercicio_clave=datos.ejercicio, lado=datos.lado, meta=datos.meta,
        repeticiones=datos.repeticiones, tiempo_sostenido_ms=datos.tiempo_sostenido_ms,
        aprobado_por=datos.aprobado_por)
    bd.add(objetivo)
    bd.commit()
    return _objetivo_json(objetivo)


# --- sesiones y resultados ----------------------------------------------------
@rutas.post("/sesiones", status_code=201)
def crear_sesion(datos: NuevaSesion, bd: Session = Depends(sesion_bd)) -> dict:
    paciente = _paciente(bd, datos.paciente)
    if not paciente.consentimiento_vigente:
        raise HTTPException(403, "El jugador no tiene un consentimiento vigente: la sesión no se guarda")
    sesion = Sesion(paciente_id=paciente.id)
    bd.add(sesion)
    bd.commit()
    return {"id": sesion.id}


@rutas.patch("/sesiones/{sesion_id}")
def cerrar_sesion(sesion_id: int, datos: CierreSesion, bd: Session = Depends(sesion_bd)) -> dict:
    sesion = bd.get(Sesion, sesion_id)
    if not sesion:
        raise HTTPException(404, "Sesión no encontrada")
    sesion.fin = ahora()
    sesion.latencia_promedio_ms = datos.latencia_promedio_ms
    bd.commit()
    return {"id": sesion.id, "fin": _iso(sesion.fin)}


@rutas.post("/sesiones/{sesion_id}/resultados", status_code=201)
def guardar_resultado(sesion_id: int, datos: ResultadoEntrada, bd: Session = Depends(sesion_bd)) -> dict:
    sesion = bd.get(Sesion, sesion_id)
    if not sesion:
        raise HTTPException(404, "Sesión no encontrada")
    if sesion.fin is not None:
        raise HTTPException(409, "La sesión ya está cerrada")
    _regla(datos.ejercicio)
    resultado = ResultadoEjercicio(
        sesion_id=sesion.id, ejercicio_clave=datos.ejercicio, lado=datos.lado, tipo=datos.tipo,
        meta=datos.meta, angulo_max=datos.angulo_max, angulo_min=datos.angulo_min, rango=datos.rango,
        mejor=datos.mejor, reposo=datos.reposo, validas=datos.validas, intentadas=datos.intentadas,
        compensaciones=datos.compensaciones, completo=datos.completo, fps_promedio=datos.fps_promedio,
        repeticiones=[Repeticion(**r.model_dump()) for r in datos.repeticiones])
    bd.add(resultado)
    bd.commit()
    return {"id": resultado.id}


# --- progreso -----------------------------------------------------------------
@rutas.get("/pacientes/{codigo}/progreso")
def progreso(codigo: str, bd: Session = Depends(sesion_bd)) -> list[dict]:
    """Por ejercicio y lado: el rango medido en la evaluación inicial y cómo ha cambiado.

    `mejor` es siempre el valor más cercano a la meta (el máximo en ejercicios "arriba" y el
    mínimo en "abajo"); `mejora` se expresa en grados ganados, positivo = avance.
    """
    paciente = _paciente(bd, codigo)
    resultados = bd.scalars(
        select(ResultadoEjercicio).join(Sesion).where(Sesion.paciente_id == paciente.id,
                                                      ResultadoEjercicio.mejor.is_not(None))
        .order_by(ResultadoEjercicio.fecha))
    metas = {(o.ejercicio_clave, o.lado): o.meta for o in _objetivos_vigentes(bd, paciente.id)}
    reglas = cargar().ejercicios
    series: dict[tuple[str, str], dict] = {}
    for r in resultados:
        regla = reglas.get(r.ejercicio_clave)
        if not regla:
            continue
        serie = series.setdefault((r.ejercicio_clave, r.lado), {
            "ejercicio": r.ejercicio_clave, "nombre": regla.nombre, "lado": r.lado,
            "direccion": regla.direccion,
            # Rango de una persona sin patología (regla 3): techo en "arriba", pierna recta (0°) en "abajo".
            "referencia": regla.max_fisiologico if regla.direccion == "arriba" else 0,
            "meta": metas.get((r.ejercicio_clave, r.lado), regla.meta_por_defecto),
            "meta_aprobada": (r.ejercicio_clave, r.lado) in metas,
            "inicial": None, "puntos": [],
        })
        punto = {"fecha": _iso(r.fecha), "tipo": r.tipo, "mejor": r.mejor, "reposo": r.reposo,
                 "validas": r.validas, "intentadas": r.intentadas}
        if serie["inicial"] is None and r.tipo == "evaluacion":
            serie["inicial"] = punto
        serie["puntos"].append(punto)
    salida = []
    signo = {"arriba": 1, "abajo": -1}
    for serie in series.values():
        base = serie["inicial"] or serie["puntos"][0]
        ultimo = serie["puntos"][-1]
        mejor_historico = (max if serie["direccion"] == "arriba" else min)(p["mejor"] for p in serie["puntos"])
        serie["ultimo"] = ultimo
        serie["mejor_historico"] = mejor_historico
        serie["mejora"] = round(signo[serie["direccion"]] * (ultimo["mejor"] - base["mejor"]), 1)
        serie["faltante_referencia"] = round(abs(serie["referencia"] - ultimo["mejor"]), 1)
        salida.append(serie)
    return salida
