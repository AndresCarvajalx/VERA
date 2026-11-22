"""Rutas REST de la API de datos: catálogo, jugadores, metas, sesiones, resultados y progreso."""
import re
import statistics
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.reglas import cargar

from .adaptacion import Serie, calcular_plan
from .bd import sesion_bd
from .modelos import (Consentimiento, EncuestaSUS, Ejercicio, MedicionReferencia, ObjetivoAngular, Paciente,
                      Repeticion, ResultadoEjercicio, Sesion, ahora)

rutas = APIRouter()

# Personajes elegibles; sus modelos los genera modelado/generar_personajes.py en web/modelos/.
PERSONAJES = {
    "persona": {"nombre": "Persona", "descripcion": "Deportista en ropa de entrenamiento."},
    "mujer": {"nombre": "Mujer", "descripcion": "Deportista con cola de caballo y ropa de entrenamiento."},
    "toribara": {"nombre": "Toribara", "descripcion": "Mitad toro, mitad capibara: cuernos, mechón y pezuñas."},
    "conejibara": {"nombre": "Conejibara", "descripcion": "Mitad conejo, mitad capibara: orejas largas y cola de pompón."},
}
PERSONAJE_POR_DEFECTO = "persona"
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


class CambioPaciente(BaseModel):
    personaje: str


class NuevaSesion(BaseModel):
    paciente: str


class CierreSesion(BaseModel):
    latencia_promedio_ms: float | None = Field(None, ge=0, le=60000)
    latencia_p95_ms: float | None = Field(None, ge=0, le=60000)
    fps_promedio: float | None = Field(None, ge=0, le=240)
    terminar: bool = True  # False: solo actualiza el rendimiento (la sesión sigue abierta)


class RespuestasSUS(BaseModel):
    respuestas: list[int] = Field(min_length=10, max_length=10, description="Diez respuestas de 1 a 5, en orden.")


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
    duracion_s: float | None = Field(default=None, ge=0)
    repeticiones: list[RepeticionEntrada] = []
    # Solo en calibraciones: el pico sostenido de cada intento y qué tan parecidos fueron.
    intentos: list[float] = []
    dispersion: float | None = None
    consistente: bool | None = None


# --- utilidades ---------------------------------------------------------------
def _iso(fecha: datetime) -> str:
    """SQLite devuelve las fechas sin zona; se guardaron en UTC y así se informan al navegador."""
    return (fecha if fecha.tzinfo else fecha.replace(tzinfo=timezone.utc)).isoformat()


def _dia(fecha: datetime) -> str:
    """El día del jugador: el servicio corre en su mismo equipo, así que vale la zona horaria local."""
    return (fecha if fecha.tzinfo else fecha.replace(tzinfo=timezone.utc)).astimezone().date().isoformat()


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


@rutas.get("/rangos")
def rangos() -> dict:
    """Rangos de movimiento de una persona adulta sin patología (Kapandji), para el manual."""
    reglas = cargar()
    return {"fuente": reglas.fuente_rangos, "rangos": list(reglas.rangos_referencia)}


@rutas.get("/personajes")
def personajes() -> list[dict]:
    return [{"clave": clave, **datos, "modelo": f"modelos/{clave}.glb", "imagen": f"modelos/{clave}.png"}
            for clave, datos in PERSONAJES.items()]


@rutas.get("/pacientes/{codigo}")
def ver_paciente(codigo: str, bd: Session = Depends(sesion_bd)) -> dict:
    paciente = _paciente(bd, codigo)
    return {"codigo": paciente.codigo, "consentimiento_vigente": paciente.consentimiento_vigente,
            "personaje": paciente.personaje or PERSONAJE_POR_DEFECTO,
            "objetivos": [_objetivo_json(o) for o in _objetivos_vigentes(bd, paciente.id)]}


@rutas.patch("/pacientes/{codigo}")
def cambiar_paciente(codigo: str, datos: CambioPaciente, bd: Session = Depends(sesion_bd)) -> dict:
    if datos.personaje not in PERSONAJES:
        raise HTTPException(422, f"Personaje desconocido: {datos.personaje}. Opciones: {sorted(PERSONAJES)}")
    paciente = _paciente(bd, codigo)
    paciente.personaje = datos.personaje
    bd.commit()
    return {"codigo": paciente.codigo, "personaje": paciente.personaje}


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
    if datos.terminar:
        sesion.fin = ahora()
    for campo in ("latencia_promedio_ms", "latencia_p95_ms", "fps_promedio"):
        if getattr(datos, campo) is not None:
            setattr(sesion, campo, getattr(datos, campo))
    bd.commit()
    return {"id": sesion.id, "fin": _iso(sesion.fin) if sesion.fin else None}


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
        duracion_s=datos.duracion_s,
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


# --- encuesta de usabilidad e indicadores técnicos (OE4) ---------------------------
META_SUS = 68.0
META_FPS = 15.0
META_LATENCIA_MS = 200.0


def puntaje_sus(respuestas: list[int]) -> float:
    """SUS: las afirmaciones impares son positivas (respuesta − 1) y las pares negativas (5 − respuesta)."""
    if len(respuestas) != 10 or any(not 1 <= r <= 5 for r in respuestas):
        raise ValueError("Se necesitan 10 respuestas de 1 a 5")
    return sum(r - 1 if i % 2 == 0 else 5 - r for i, r in enumerate(respuestas)) * 2.5


@rutas.post("/pacientes/{codigo}/sus", status_code=201)
def guardar_sus(codigo: str, datos: RespuestasSUS, bd: Session = Depends(sesion_bd)) -> dict:
    paciente = _paciente(bd, codigo)
    try:
        puntaje = puntaje_sus(datos.respuestas)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    encuesta = EncuestaSUS(paciente_id=paciente.id, respuestas=",".join(map(str, datos.respuestas)), puntaje=puntaje)
    bd.add(encuesta)
    bd.commit()
    return {"id": encuesta.id, "puntaje": puntaje, "cumple_meta": puntaje >= META_SUS}


@rutas.get("/pacientes/{codigo}/sus")
def ver_sus(codigo: str, bd: Session = Depends(sesion_bd)) -> dict:
    paciente = _paciente(bd, codigo)
    ultima = bd.scalar(select(EncuestaSUS).where(EncuestaSUS.paciente_id == paciente.id).order_by(EncuestaSUS.fecha.desc()))
    return {"respondida": ultima is not None, "puntaje": ultima.puntaje if ultima else None,
            "fecha": _iso(ultima.fecha) if ultima else None}


def _media(valores: list[float]) -> float | None:
    return round(sum(valores) / len(valores), 1) if valores else None


@rutas.get("/indicadores")
def indicadores(bd: Session = Depends(sesion_bd)) -> dict:
    """Indicadores técnicos del OE4 con los datos de todos los jugadores: precisión frente al goniómetro,
    fluidez (FPS), latencia y usabilidad (SUS). Para el informe técnico; no contiene datos clínicos."""
    mediciones = list(bd.scalars(select(MedicionReferencia)))
    por_articulacion: dict[str, list[tuple[float, float]]] = {}
    for m in mediciones:
        por_articulacion.setdefault(m.articulacion, []).append((m.angulo_goniometro, m.angulo_sistema))
    fps = [r.fps_promedio for r in bd.scalars(select(ResultadoEjercicio)) if r.fps_promedio]
    latencias = [s.latencia_promedio_ms for s in bd.scalars(select(Sesion)) if s.latencia_promedio_ms is not None]
    p95 = [s.latencia_p95_ms for s in bd.scalars(select(Sesion)) if s.latencia_p95_ms is not None]
    # La última encuesta de cada jugador: si la respondió dos veces, cuenta su opinión más reciente.
    ultimas: dict[int, EncuestaSUS] = {}
    for e in bd.scalars(select(EncuestaSUS).order_by(EncuestaSUS.fecha)):
        ultimas[e.paciente_id] = e
    sus = [e.puntaje for e in ultimas.values()]
    porcentaje = lambda valores, cumple: round(100 * sum(map(cumple, valores)) / len(valores)) if valores else None
    return {
        "precision": {
            "meta": META_ERROR_ABSOLUTO_MEDIO,
            "total": resumen_errores([(m.angulo_goniometro, m.angulo_sistema) for m in mediciones]) if mediciones else None,
            "por_articulacion": {a: resumen_errores(p) for a, p in sorted(por_articulacion.items())},
            "jugadores": len({bd.get(Sesion, m.sesion_id).paciente_id for m in mediciones}),
        },
        "fps": {"meta": META_FPS, "n": len(fps), "promedio": _media(fps), "minimo": round(min(fps), 1) if fps else None,
                "porcentaje_cumple": porcentaje(fps, lambda v: v >= META_FPS)},
        "latencia": {"meta": META_LATENCIA_MS, "n": len(latencias), "promedio": _media(latencias), "p95_promedio": _media(p95),
                     "porcentaje_cumple": porcentaje(latencias, lambda v: v <= META_LATENCIA_MS)},
        "sus": {"meta": META_SUS, "n": len(sus), "promedio": _media(sus),
                "porcentaje_cumple": porcentaje(sus, lambda v: v >= META_SUS)},
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
    """Por ejercicio y pierna: el rango calibrado en cada sesión, desde la primera."""
    return _series(bd, _paciente(bd, codigo), lambda r: r.sesion_id)


@rutas.get("/pacientes/{codigo}/diario")
def diario(codigo: str, bd: Session = Depends(sesion_bd)) -> dict:
    """Lo jugado cada día (tiempo, series, repeticiones) y el rango calibrado de cada día.

    `sin_tiempo`: resultados guardados antes de medir la duración; su tiempo no se conoce y no se estima.
    """
    paciente = _paciente(bd, codigo)
    dias: dict[str, dict] = {}
    for r in bd.scalars(select(ResultadoEjercicio).join(Sesion).where(Sesion.paciente_id == paciente.id)):
        dia = dias.setdefault(_dia(r.fecha), {"dia": _dia(r.fecha), "segundos": 0.0, "series": 0, "calibraciones": 0,
                                              "validas": 0, "intentadas": 0, "sin_tiempo": 0})
        if r.duracion_s is None:
            dia["sin_tiempo"] += 1
        else:
            dia["segundos"] = round(dia["segundos"] + r.duracion_s, 1)
        if r.tipo == "juego":
            dia["series"] += 1
            dia["validas"] += r.validas or 0
            dia["intentadas"] += r.intentadas or 0
        elif r.completo:
            dia["calibraciones"] += 1
    return {"dias": [dias[d] for d in sorted(dias)], "series": _series(bd, paciente, lambda r: _dia(r.fecha))}


def rachas(dias: set[date], hoy: date) -> tuple[int, int]:
    """(racha actual, mejor racha) en días seguidos jugados.

    La racha actual sigue viva si el último día jugado fue hoy o ayer: hoy todavía puede jugar.
    """
    mejor = actual = 0
    anterior = None
    for d in sorted(dias):
        actual = actual + 1 if anterior is not None and d - anterior == timedelta(days=1) else 1
        mejor, anterior = max(mejor, actual), d
    viva = anterior is not None and hoy - anterior <= timedelta(days=1)
    return (actual if viva else 0), mejor


# (clave, nombre, descripción, icono, meta). El progreso de cada uno se calcula en `logros`.
LOGROS = [
    ("primera_serie", "Primera serie", "Completa tu primera serie del juego.", "medalla", 1),
    ("sin_fallos", "Sin fallos", "Completa una serie en la que todas las repeticiones cuenten.", "diana", 1),
    ("racha_3", "Tres días seguidos", "Juega tres días seguidos.", "llama", 3),
    ("racha_7", "Una semana seguida", "Juega siete días seguidos.", "llama", 7),
    ("series_10", "Diez series", "Completa diez series del juego.", "medalla", 10),
    ("rango_5", "Cinco grados más", "Gana 5° de rango en un ejercicio desde tu primera calibración.", "grafica", 5),
    ("rango_15", "Quince grados más", "Gana 15° de rango en un ejercicio desde tu primera calibración.", "grafica", 15),
    ("todos", "Explorador", "Calibra los cuatro ejercicios.", "estrella", 4),
    ("tiempo_30", "Media hora en movimiento", "Suma 30 minutos de ejercicio.", "reloj", 30),
]


@rutas.get("/pacientes/{codigo}/logros")
def logros(codigo: str, bd: Session = Depends(sesion_bd)) -> dict:
    """Racha de días seguidos y logros (obtenidos o con su avance), calculados de lo guardado."""
    paciente = _paciente(bd, codigo)
    resultados = list(bd.scalars(select(ResultadoEjercicio).join(Sesion).where(Sesion.paciente_id == paciente.id)))
    dias = {date.fromisoformat(_dia(r.fecha)) for r in resultados}
    actual, mejor = rachas(dias, datetime.now().astimezone().date())
    series = [r for r in resultados if r.tipo == "juego" and r.completo]
    calibrados = {r.ejercicio_clave for r in resultados if r.tipo == "calibracion" and r.completo and r.mejor is not None}
    mejoras = [s["mejora"] for s in _series(bd, paciente, lambda r: r.id)]
    avance = {
        "primera_serie": len(series),
        "sin_fallos": int(any(r.validas and r.validas == r.intentadas for r in series)),
        "racha_3": mejor, "racha_7": mejor,
        "series_10": len(series),
        "rango_5": max(mejoras, default=0), "rango_15": max(mejoras, default=0),
        "todos": len(calibrados & set(cargar().ejercicios)),
        "tiempo_30": sum(r.duracion_s or 0 for r in resultados) / 60,
    }
    return {
        "racha": actual, "mejor_racha": mejor, "dias_jugados": len(dias),
        "jugo_hoy": datetime.now().astimezone().date() in dias,
        "logros": [{"clave": clave, "nombre": nombre, "descripcion": descripcion, "icono": icono, "meta": meta,
                    "avance": round(min(max(avance[clave], 0), meta), 1), "obtenido": avance[clave] >= meta}
                   for clave, nombre, descripcion, icono, meta in LOGROS],
    }


def _series(bd: Session, paciente: Paciente, grupo: Callable[[ResultadoEjercicio], object]) -> list[dict]:
    """Una serie por ejercicio y pierna, con un punto por `grupo` (sesión o día).

    La medida de progreso es la calibración (mediana de picos sostenidos de varios intentos),
    no el mejor fotograma de una partida, que puede incluir picos sueltos. Cada punto lleva
    además el resumen de las partidas de ese grupo. `mejora`: grados ganados, positivo = avance.
    """
    reglas = cargar().ejercicios
    juegos: dict[tuple, list[ResultadoEjercicio]] = {}
    for j in bd.scalars(select(ResultadoEjercicio).join(Sesion).where(
            Sesion.paciente_id == paciente.id, ResultadoEjercicio.tipo == "juego")):
        juegos.setdefault((grupo(j), j.ejercicio_clave, j.lado), []).append(j)

    # Un punto por grupo: si se calibró varias veces, cuenta la última (la que usó el juego).
    por_grupo: dict[tuple, ResultadoEjercicio] = {}
    for c in _calibraciones(bd, paciente.id):
        por_grupo[(grupo(c), c.ejercicio_clave, c.lado)] = c
    series: dict[tuple[str, str], dict] = {}
    for c in sorted(por_grupo.values(), key=lambda r: (r.fecha, r.id)):
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
        partidas = juegos.get((grupo(c), c.ejercicio_clave, c.lado), [])
        serie["puntos"].append({
            "fecha": _iso(c.fecha), "dia": _dia(c.fecha), "mejor": c.mejor, "reposo": c.reposo,
            "consistente": c.consistente,
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
