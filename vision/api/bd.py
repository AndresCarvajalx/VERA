"""Conexión a la base de datos. SQLite en el servidor de pruebas; migrable a PostgreSQL
cambiando la URL (variable de entorno BD_URL)."""
import os
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.reglas import cargar

from .modelos import Base, Ejercicio

RAIZ = Path(__file__).resolve().parents[2]
URL_POR_DEFECTO = f"sqlite:///{(RAIZ / 'data' / 'amc.sqlite3').as_posix()}"

_fabrica: sessionmaker | None = None


def iniciar(url: str | None = None, **opciones) -> Engine:
    """Crea las tablas si no existen y sincroniza el catálogo de ejercicios con las reglas."""
    global _fabrica
    url = url or os.environ.get("BD_URL", URL_POR_DEFECTO)
    if url.startswith("sqlite:///") and ":memory:" not in url:
        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    motor = create_engine(url, **opciones)
    Base.metadata.create_all(motor)
    migrar(motor)
    _fabrica = sessionmaker(motor, expire_on_commit=False)
    with _fabrica() as bd:
        sincronizar_catalogo(bd)
    return motor


def migrar(motor: Engine) -> None:
    """Actualiza una base creada con una versión anterior del prototipo sin perder sus datos.

    create_all no agrega columnas a tablas que ya existen: se agregan aquí las que falten
    (todas las nuevas admiten nulos). Además, las "evaluaciones" de rango por tiempo fijo de la
    versión anterior pasan a ser calibraciones; quedan con `consistente` en nulo porque ese
    método no medía la coherencia entre intentos.
    """
    with motor.begin() as conexion:
        for tabla in Base.metadata.sorted_tables:
            existentes = {c["name"] for c in inspect(conexion).get_columns(tabla.name)}
            for columna in tabla.columns:
                if columna.name not in existentes:
                    tipo = columna.type.compile(dialect=motor.dialect)
                    conexion.execute(text(f'ALTER TABLE "{tabla.name}" ADD COLUMN "{columna.name}" {tipo}'))
        conexion.execute(text("UPDATE resultado_ejercicio SET tipo = 'calibracion' WHERE tipo = 'evaluacion'"))


def sincronizar_catalogo(bd: Session) -> None:
    existentes = {e.clave: e for e in bd.scalars(select(Ejercicio))}
    for clave, r in cargar().ejercicios.items():
        e = existentes.get(clave) or Ejercicio(clave=clave)
        e.nombre, e.articulacion, e.posicion, e.direccion = r.nombre, r.articulacion, r.posicion, r.direccion
        e.meta_por_defecto, e.max_fisiologico, e.min_fisiologico = r.meta_por_defecto, r.max_fisiologico, r.min_fisiologico
        bd.add(e)
    bd.commit()


def sesion_bd() -> Iterator[Session]:
    """Dependencia de FastAPI: una sesión de base de datos por petición."""
    if _fabrica is None:
        iniciar()
    with _fabrica() as bd:
        yield bd
