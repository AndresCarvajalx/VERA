"""Reglas de rango de movimiento (ROM) por ejercicio.

Fuente única: config/reglas_rom.json, construido a partir de
docs/reglas_rango_movimiento_miembro_inferior.md. Ningún umbral se escribe en el código.
"""
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

RUTA = Path(__file__).resolve().parents[2] / "config" / "reglas_rom.json"


@dataclass(frozen=True)
class Compensacion:
    angulo: str  # "cadera", "tronco" o "rodilla" del mismo lado
    maximo: float
    mensaje: str


@dataclass(frozen=True)
class ReglaEjercicio:
    clave: str
    nombre: str
    descripcion: str
    articulacion: str  # "rodilla", "cadera" o "tobillo"
    posicion: str  # "de_pie" o "sentado"
    direccion: str  # "arriba": la meta es un ángulo alto; "abajo": la meta es un ángulo bajo
    meta_por_defecto: float
    max_fisiologico: float
    min_fisiologico: float
    inicio: float  # arriba: ángulo máximo de partida; abajo: ángulo mínimo de partida
    retorno: float  # ángulo al que hay que volver para cerrar la repetición
    compensacion: Compensacion | None

    def meta_valida(self, meta: float) -> bool:
        """La meta nunca puede exigir más que el límite fisiológico de referencia (regla 1)."""
        if self.direccion == "arriba":
            return self.inicio < meta <= self.max_fisiologico
        return self.min_fisiologico <= meta < self.inicio


@dataclass(frozen=True)
class Reglas:
    tolerancia_medicion: float
    tolerancia_meta: float
    visibilidad_minima: float
    salto_maximo: float
    ejercicios: dict[str, ReglaEjercicio]


@lru_cache
def cargar(ruta: Path = RUTA) -> Reglas:
    datos = json.loads(ruta.read_text(encoding="utf-8"))
    ejercicios = {}
    for clave, e in datos["ejercicios"].items():
        comp = e.get("compensacion")
        arriba = e["direccion"] == "arriba"
        ejercicios[clave] = ReglaEjercicio(
            clave=clave,
            nombre=e["nombre"],
            descripcion=e["descripcion"],
            articulacion=e["articulacion"],
            posicion=e["posicion"],
            direccion=e["direccion"],
            meta_por_defecto=e["meta_por_defecto"],
            max_fisiologico=e["max_fisiologico"],
            min_fisiologico=e["min_fisiologico"],
            inicio=e["inicio_max"] if arriba else e["inicio_min"],
            retorno=e["inicio_max"] if arriba else e["retorno_min"],
            compensacion=Compensacion(comp["angulo"], comp["max"], comp["mensaje"]) if comp else None,
        )
    return Reglas(
        tolerancia_medicion=datos["tolerancia_medicion"],
        tolerancia_meta=datos["tolerancia_meta"],
        visibilidad_minima=datos["visibilidad_minima"],
        salto_maximo=datos["salto_maximo"],
        ejercicios=ejercicios,
    )
