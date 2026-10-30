"""Rutas REST de la API de datos: catálogo, jugadores, metas, sesiones, resultados y progreso."""
import re
import statistics
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.reglas import cargar

from .adaptacion import Serie, calcular_plan
from .bd import sesion_bd
from .modelos import (Consentimiento, Ejercicio, MedicionReferencia, ObjetivoAngular, Paciente, Repeticion,
                      ResultadoEjercicio, Sesion, ahora)

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
    """El resumen que el servicio de visión envía al terminar una calibración o un ejercicio."""
    tipo: str = Field(pattern="^(calibracion|juego)$")
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
    # Solo en calibraciones: el pico sostenido de cada intento y qué tan parecidos fueron.
    intentos: list[float] = []
    dispersion: float | None = None
    consistente: bool | None = None


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
         "posicion_inicial": reglas.ejercicios[e.clave].posicion_inicial,
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
    repeticiones = [Repeticion(**r.model_dump()) for r in datos.repeticiones]
    repeticiones += [Repeticion(numero=i, angulo_pico=pico, sostenido_ms=0, valida=True, motivo="intento")
                     for i, pico in enumerate(datos.intentos, start=1)]
    resultado = ResultadoEjercicio(
        sesion_id=sesion.id, ejercicio_clave=datos.ejercicio, lado=datos.lado, tipo=datos.tipo,
        meta=datos.meta, angulo_max=datos.angulo_max, angulo_min=datos.angulo_min, rango=datos.rango,
        mejor=datos.mejor, reposo=datos.reposo, validas=datos.validas, intentadas=datos.intentadas,
        compensaciones=datos.compensaciones, completo=datos.completo, fps_promedio=datos.fps_promedio,
        dispersion=datos.dispersion, consistente=datos.consistente, repeticiones=repeticiones)
    bd.add(resultado)
    bd.commit()
    return {"id": resultado.id}


def _calibraciones(bd: Session, paciente_id: int, ejercicio: str | None = None, lado: str | None = None,
                   sesion_id: int | None = None) -> list[ResultadoEjercicio]:
    # `consistente` nulo = "evaluación" por tiempo fijo de la versión anterior (bd.migrar): era
    # imprecisa (50°, 24° y 44° en una misma sesión real), así que no se compara con las nuevas.
    consulta = select(ResultadoEjercicio).join(Sesion).where(
        Sesion.paciente_id == paciente_id, ResultadoEjercicio.tipo == "calibracion",
        ResultadoEjercicio.completo, ResultadoEjercicio.mejor.is_not(None),
        ResultadoEjercicio.consistente.is_not(None))
    if ejercicio:
        consulta = consulta.where(ResultadoEjercicio.ejercicio_clave == ejercicio, ResultadoEjercicio.lado == lado)
    if sesion_id:
        consulta = consulta.where(ResultadoEjercicio.sesion_id == sesion_id)
    return list(bd.scalars(consulta.order_by(ResultadoEjercicio.fecha, ResultadoEjercicio.id)))


def _meta_fisioterapeuta(bd: Session, paciente_id: int, ejercicio: str, lado: str) -> float | None:
    for o in _objetivos_vigentes(bd, paciente_id):
        if o.ejercicio_clave == ejercicio and o.lado == lado:
            return o.meta
    return None


# --- mediciones de referencia (CU-14, OE4) -----------------------------------------
META_ERROR_ABSOLUTO_MEDIO = 10.0  # indicador de la propuesta: MAE ≤ 10° frente a goniometría


class NuevaMedicion(BaseModel):
    articulacion: str = Field(pattern="^(rodilla|cadera|tobillo)$")
    lado: Lado = Field(pattern="^(izq|der)$")
    angulo_goniometro: float = Field(ge=-60, le=180)
    angulo_sistema: float = Field(ge=-60, le=180)
    dispersion_sistema: float = Field(ge=0, le=3, description="Solo se aceptan lecturas estables (≤ 3°)")
    evaluador: str = Field(min_length=1, max_length=80)


@rutas.post("/sesiones/{sesion_id}/mediciones-referencia", status_code=201)
def guardar_medicion(sesion_id: int, datos: NuevaMedicion, bd: Session = Depends(sesion_bd)) -> dict:
    sesion = bd.get(Sesion, sesion_id)
    if not sesion:
        raise HTTPException(404, "Sesión no encontrada")
    medicion = MedicionReferencia(sesion_id=sesion.id, **datos.model_dump())
    bd.add(medicion)
    bd.commit()
    return {"id": medicion.id, "error": round(medicion.angulo_sistema - medicion.angulo_goniometro, 1)}


def resumen_errores(pares: list[tuple[float, float]]) -> dict:
    """pares: (goniómetro, sistema). Error = sistema − goniómetro."""
    errores = [s - g for g, s in pares]
    absolutos = [abs(e) for e in errores]
    mae = sum(absolutos) / len(absolutos)
    return {
        "n": len(errores),
        "error_absoluto_medio": round(mae, 1),
        "sesgo": round(sum(errores) / len(errores), 1),  # + = el sistema mide de más
        "desviacion_error": round(statistics.pstdev(errores), 1),
        "error_maximo": round(max(absolutos), 1),
        "cumple_meta": mae <= META_ERROR_ABSOLUTO_MEDIO,
    }


@rutas.get("/pacientes/{codigo}/precision")
def precision(codigo: str, bd: Session = Depends(sesion_bd)) -> dict:
    """Error del sistema frente al goniómetro, por articulación y en total (indicador del OE4)."""
    paciente = _paciente(bd, codigo)
    mediciones = list(bd.scalars(select(MedicionReferencia).join(Sesion).where(
        Sesion.paciente_id == paciente.id).order_by(MedicionReferencia.fecha)))
    por_articulacion: dict[str, list[tuple[float, float]]] = {}
    for m in mediciones:
        por_articulacion.setdefault(m.articulacion, []).append((m.angulo_goniometro, m.angulo_sistema))
    return {
        "meta": META_ERROR_ABSOLUTO_MEDIO,
        "total": resumen_errores([(m.angulo_goniometro, m.angulo_sistema) for m in mediciones]) if mediciones else None,
        "por_articulacion": {a: resumen_errores(p) for a, p in por_articulacion.items()},
        "mediciones": [{"fecha": _iso(m.fecha), "articulacion": m.articulacion, "lado": m.lado,
                        "goniometro": m.angulo_goniometro, "sistema": m.angulo_sistema,
                        "error": round(m.angulo_sistema - m.angulo_goniometro, 1), "evaluador": m.evaluador}
                       for m in mediciones],
    }


# --- plan adaptado --------------------------------------------------------------
@rutas.get("/pacientes/{codigo}/plan")
def plan(codigo: str, ejercicio: str, lado: str, sesion: int | None = None,
         bd: Session = Depends(sesion_bd)) -> dict:
    """Meta y dosificación del próximo juego, calculadas a partir de la calibración (adaptacion.py).

    El rango cambia de un día a otro, así que solo sirve una calibración de esta misma sesión.
    """
    paciente = _paciente(bd, codigo)
    regla = _regla(ejercicio)
    normal = {"referencia": regla.max_fisiologico if regla.direccion == "arriba" else 0,
              "direccion": regla.direccion}
    calibraciones = _calibraciones(bd, paciente.id, ejercicio, lado, sesion) if sesion else []
    if not calibraciones:
        return {"requiere_calibracion": True, **normal}
    calibracion = calibraciones[-1]
    juegos = bd.scalars(select(ResultadoEjercicio).where(
        ResultadoEjercicio.sesion_id == sesion, ResultadoEjercicio.tipo == "juego",
        ResultadoEjercicio.ejercicio_clave == ejercicio, ResultadoEjercicio.lado == lado,
        ResultadoEjercicio.id > calibracion.id).order_by(ResultadoEjercicio.id))
    calculado = calcular_plan(
        regla, {"mejor": calibracion.mejor, "reposo": calibracion.reposo},
        [Serie(j.validas, j.intentadas, j.meta) for j in juegos],
        _meta_fisioterapeuta(bd, paciente.id, ejercicio, lado))
    return {"requiere_calibracion": False, **normal, **calculado,
            "calibracion": {"fecha": _iso(calibracion.fecha), "consistente": calibracion.consistente,
                            "dispersion": calibracion.dispersion}}


# --- progreso -----------------------------------------------------------------
@rutas.get("/pacientes/{codigo}/progreso")
def progreso(codigo: str, bd: Session = Depends(sesion_bd)) -> list[dict]:
    """Por ejercicio y pierna: el rango calibrado en cada sesión, desde la primera.

    La medida de progreso es la calibración (mediana de picos sostenidos de varios intentos),
    no el mejor fotograma de una partida, que puede incluir picos sueltos. Cada punto lleva
    además el resumen de las partidas de esa sesión. `mejora`: grados ganados, positivo = avance.
    """
    paciente = _paciente(bd, codigo)
    reglas = cargar().ejercicios
    juegos: dict[tuple, list[ResultadoEjercicio]] = {}
    for j in bd.scalars(select(ResultadoEjercicio).join(Sesion).where(
            Sesion.paciente_id == paciente.id, ResultadoEjercicio.tipo == "juego")):
        juegos.setdefault((j.sesion_id, j.ejercicio_clave, j.lado), []).append(j)

    # Un punto por sesión: si se calibró varias veces, cuenta la última (la que usó el juego).
    por_sesion: dict[tuple, ResultadoEjercicio] = {}
    for c in _calibraciones(bd, paciente.id):
        por_sesion[(c.sesion_id, c.ejercicio_clave, c.lado)] = c
    series: dict[tuple[str, str], dict] = {}
    for c in sorted(por_sesion.values(), key=lambda r: (r.fecha, r.id)):
        regla = reglas.get(c.ejercicio_clave)
        if not regla:
            continue
        serie = series.setdefault((c.ejercicio_clave, c.lado), {
            "ejercicio": c.ejercicio_clave, "nombre": regla.nombre, "lado": c.lado,
            "direccion": regla.direccion,
            # Rango de una persona sin patología (regla 3): techo en "arriba", pierna recta (0°) en "abajo".
            "referencia": regla.max_fisiologico if regla.direccion == "arriba" else 0,
            "puntos": [],
        })
        partidas = juegos.get((c.sesion_id, c.ejercicio_clave, c.lado), [])
        serie["puntos"].append({
            "fecha": _iso(c.fecha), "mejor": c.mejor, "reposo": c.reposo, "consistente": c.consistente,
            "partidas": len(partidas),
            "validas": sum(p.validas or 0 for p in partidas),
            "intentadas": sum(p.intentadas or 0 for p in partidas),
            "meta": partidas[-1].meta if partidas else None,
        })
    salida = []
    signo = {"arriba": 1, "abajo": -1}
    for serie in series.values():
        base, ultimo = serie["puntos"][0], serie["puntos"][-1]
        serie["inicial"], serie["ultimo"] = base, ultimo
        serie["mejor_historico"] = (max if serie["direccion"] == "arriba" else min)(p["mejor"] for p in serie["puntos"])
        serie["mejora"] = round(signo[serie["direccion"]] * (ultimo["mejor"] - base["mejor"]), 1)
        serie["faltante_referencia"] = round(abs(serie["referencia"] - ultimo["mejor"]), 1)
        serie["meta"] = next((p["meta"] for p in reversed(serie["puntos"]) if p["meta"] is not None), None)
        salida.append(serie)
    return salida
