"""Ajustes del equipo (p. ej. qué cámara usar), guardados en data/ajustes.json para que
sobrevivan a un reinicio del servicio. Son del equipo, no de un jugador."""
import json
import logging
from pathlib import Path

RUTA = Path(__file__).resolve().parents[2] / "data" / "ajustes.json"
log = logging.getLogger(__name__)


def leer(ruta: Path = RUTA) -> dict:
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        log.warning("No se pudo leer %s; se usan los valores por defecto", ruta)
        return {}


def guardar(cambios: dict, ruta: Path = RUTA) -> dict:
    datos = {**leer(ruta), **cambios}
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")
    return datos
