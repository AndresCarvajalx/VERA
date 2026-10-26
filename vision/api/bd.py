"""Conexión a la base de datos. SQLite en el servidor de pruebas; migrable a PostgreSQL
cambiando la URL (variable de entorno BD_URL)."""
import os
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, select
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
    _fabrica = sessionmaker(motor, expire_on_commit=False)
    with _fabrica() as bd:
        sincronizar_catalogo(bd)
    return motor


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
