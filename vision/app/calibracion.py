"""Calibración de la posición neutra (CU-04).

El jugador se queda quieto unos segundos; la mediana de cada ángulo en esa ventana
es su referencia de la sesión. Con AMC la posición "neutra" puede estar lejos de los
valores normativos (p. ej. rodilla en 160° en lugar de 180°), por eso todo se mide
relativo a esta referencia y no a un valor fijo.
"""
import statistics
from dataclasses import dataclass, field

DURACION_MS = 2000
MAX_DESVIACION = 3.0  # grados; más que esto se considera que el jugador se movió


@dataclass
class Calibrador:
    duracion_ms: int = DURACION_MS
    max_desviacion: float = MAX_DESVIACION
    _t_inicio: int | None = None
    _muestras: dict[str, list[float]] = field(default_factory=dict)

    def reiniciar(self) -> None:
        self._t_inicio = None
        self._muestras = {}

    def progreso(self, t_ms: int) -> float:
        if self._t_inicio is None:
            return 0.0
        return min(1.0, (t_ms - self._t_inicio) / self.duracion_ms)

    def agregar(self, t_ms: int, angulos: dict[str, float | None], encuadre_ok: bool):
        """Devuelve None mientras recoge; al terminar, ("lista", neutros) o ("fallida", motivo)."""
        if not encuadre_ok:
            self.reiniciar()  # se espera a que vuelva a estar en cuadro; no es un fallo
            return None
        if self._t_inicio is None:
            self._t_inicio = t_ms
        for clave, valor in angulos.items():
            if valor is not None:
                self._muestras.setdefault(clave, []).append(valor)
        if t_ms - self._t_inicio < self.duracion_ms:
            return None

        muestras = {k: v for k, v in self._muestras.items() if len(v) >= 5}
        self.reiniciar()
        if not muestras:
            return ("fallida", "sin_datos")
        if any(statistics.pstdev(v) > self.max_desviacion for v in muestras.values()):
            return ("fallida", "movimiento")
        return ("lista", {k: round(statistics.median(v), 1) for k, v in muestras.items()})


def angulos_relativos(angulos: dict[str, float | None], neutros: dict[str, float]) -> dict[str, float | None]:
    """Cuánto se cerró cada articulación respecto a la neutra (positivo = flexión)."""
    return {
        clave: None if valor is None or clave not in neutros else round(neutros[clave] - valor, 1)
        for clave, valor in angulos.items()
    }
