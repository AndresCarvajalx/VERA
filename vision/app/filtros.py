"""Suavizado temporal de coordenadas: filtro One Euro (Casiez et al., 2012).

Suaviza mucho cuando el punto está quieto (quita temblor) y poco cuando se mueve
rápido (evita retraso), que es lo que necesita la retroalimentación en tiempo real.
"""
import math


class Antirrebote:
    """Estado booleano que solo cambia si la nueva lectura se mantiene `espera_ms`.

    Evita que el aviso de encuadre parpadee (y llene el registro de eventos) cuando un
    punto entra y sale del umbral de visibilidad durante unos pocos fotogramas.
    """

    def __init__(self, espera_ms: int = 300) -> None:
        self.espera_ms = espera_ms
        self.valor: bool | None = None
        self._desde: int | None = None  # cuándo empezó a leerse un valor distinto

    def actualizar(self, lectura: bool, t_ms: int) -> bool:
        if self.valor is None:
            self.valor = lectura
        elif lectura == self.valor:
            self._desde = None
        elif self._desde is None:
            self._desde = t_ms
        elif t_ms - self._desde >= self.espera_ms:
            self.valor, self._desde = lectura, None
        return self.valor


class FiltroPasoBajo:
    def __init__(self) -> None:
        self.valor: float | None = None

    def aplicar(self, x: float, alfa: float) -> float:
        self.valor = x if self.valor is None else alfa * x + (1 - alfa) * self.valor
        return self.valor


def _alfa(corte_hz: float, dt: float) -> float:
    tau = 1.0 / (2 * math.pi * corte_hz)
    return 1.0 / (1.0 + tau / dt)


class FiltroOneEuro:
    def __init__(self, corte_min: float = 1.0, beta: float = 0.05, corte_derivada: float = 1.0) -> None:
        self.corte_min = corte_min
        self.beta = beta
        self.corte_derivada = corte_derivada
        self._x = FiltroPasoBajo()
        self._dx = FiltroPasoBajo()
        self._t_anterior: float | None = None

    def aplicar(self, x: float, t: float) -> float:
        """x: valor nuevo; t: tiempo en segundos."""
        if self._t_anterior is None or t <= self._t_anterior:
            self._t_anterior = t
            self._dx.aplicar(0.0, 1.0)
            return self._x.aplicar(x, 1.0)
        dt = t - self._t_anterior
        self._t_anterior = t
        anterior = self._x.valor
        dx = (x - anterior) / dt
        dx_suave = self._dx.aplicar(dx, _alfa(self.corte_derivada, dt))
        corte = self.corte_min + self.beta * abs(dx_suave)
        return self._x.aplicar(x, _alfa(corte, dt))

    def reiniciar(self) -> None:
        self.__init__(self.corte_min, self.beta, self.corte_derivada)
