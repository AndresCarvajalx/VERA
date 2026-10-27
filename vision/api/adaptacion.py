"""Plan del juego adaptado al jugador: la meta sale de su calibración, no de lo que escriba.

1. Sin calibración de este ejercicio y pierna en la sesión actual no hay plan: hay que
   calibrar (el rango cambia de un día a otro).
2. Si el fisioterapeuta aprobó una meta, se usa esa (regla 1 de las reglas ROM).
3. Si no, la meta inicial es `fraccion_rango` del rango calibrado (desde el reposo hacia el
   mejor intento): exigente pero alcanzable de forma repetida.
4. Tras cada serie de la sesión, si el jugador logró ≥ `exito_subir` de repeticiones válidas
   la meta sube `paso` grados; si logró < `exito_bajar`, baja `paso`.
5. Siempre se recorta a lo jugable (lejos del inicio) y a lo seguro: nunca más allá de lo
   calibrado + `margen_sobre_calibracion` ni del límite fisiológico.
"""
from dataclasses import dataclass

from app.controlador import MARGEN_REPOSO
from app.reglas import ReglaEjercicio, cargar
from app.repeticiones import HISTERESIS


@dataclass
class Serie:
    validas: int | None
    intentadas: int | None
    meta: float | None


def limites_meta(regla: ReglaEjercicio, mejor: float, reposo: float) -> tuple[float, float]:
    """(más fácil, más difícil) metas permitidas, expresadas en v = signo · ángulo."""
    reglas = cargar()
    tol, margen = reglas.tolerancia_meta, reglas.adaptacion.margen_sobre_calibracion
    s = 1 if regla.direccion == "arriba" else -1
    if s == 1:
        inicio = max(regla.inicio, reposo + MARGEN_REPOSO)
        techo = regla.max_fisiologico
    else:
        inicio = min(regla.retorno, regla.inicio, reposo - MARGEN_REPOSO)
        techo = regla.min_fisiologico
    facil = s * inicio + tol + HISTERESIS + 1  # lo mínimo para que el contador distinga la meta
    dificil = min(s * mejor + margen, s * techo)
    return facil, dificil


def calcular_plan(regla: ReglaEjercicio, calibracion: dict, series: list[Serie],
                  meta_fisioterapeuta: float | None) -> dict:
    """calibracion: {"mejor", "reposo"} del último resultado de calibración de la sesión."""
    p = cargar().adaptacion
    s = 1 if regla.direccion == "arriba" else -1
    mejor, reposo = calibracion["mejor"], calibracion["reposo"]
    facil, dificil = limites_meta(regla, mejor, reposo)
    base = {"reposo": reposo, "calibrado": mejor, "repeticiones": p.repeticiones,
            "tiempo_sostenido_ms": p.tiempo_sostenido_ms, "fraccion_rango": p.fraccion_rango}

    if meta_fisioterapeuta is not None:
        return {**base, "meta": meta_fisioterapeuta, "origen": "fisioterapeuta", "ajuste": 0, "jugable": True}

    v = s * reposo + p.fraccion_rango * (s * mejor - s * reposo)
    ajuste = 0.0
    for serie in series:
        if not serie.intentadas:
            continue
        exito = (serie.validas or 0) / serie.intentadas
        if exito >= p.exito_subir:
            ajuste += p.paso
        elif exito < p.exito_bajar:
            ajuste -= p.paso
    v = max(min(v + ajuste, dificil), facil)  # si se cruzan, gana lo jugable y se marca abajo
    return {
        **base,
        "meta": round(s * v),
        "origen": "calibracion",
        "ajuste": ajuste,
        # Con un rango muy pequeño la meta mínima jugable puede quedar fuera de lo que se midió.
        "jugable": facil <= s * mejor,
    }
