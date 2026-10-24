"""Conteo de repeticiones con máquina de estados e histéresis.

    reposo → subiendo → en_objetivo → bajando → reposo

Una repetición es válida solo si la amplitud llegó a (objetivo − tolerancia), se
sostuvo ahí el tiempo indicado y luego el jugador volvió al reposo. Si vuelve al
reposo sin cumplirlo, la repetición queda como incompleta (no se penaliza).
Las bandas de histéresis evitan que el temblor del ángulo cuente repeticiones dobles.
"""
from dataclasses import dataclass, field

HISTERESIS = 3.0  # grados por debajo del umbral antes de considerar que salió del objetivo
FRACCION_INICIO = 0.25  # la repetición "empieza" al pasar el 25 % del objetivo
INICIO_MINIMO = 5.0  # pero nunca con menos de 5°, que es ruido


@dataclass
class Repeticion:
    numero: int
    angulo_pico: float
    sostenido_ms: int
    valida: bool


@dataclass
class ContadorRepeticiones:
    objetivo: float  # amplitud meta en grados, relativa a la posición neutra
    tolerancia: float = 5.0
    tiempo_sostenido_ms: int = 1000
    estado: str = "reposo"
    repeticiones: list[Repeticion] = field(default_factory=list)
    _pico: float = 0.0
    _sostenido_ms: int = 0
    _cumplida: bool = False
    _t_anterior: int | None = None

    @property
    def umbral_objetivo(self) -> float:
        return self.objetivo - self.tolerancia

    @property
    def umbral_inicio(self) -> float:
        return max(INICIO_MINIMO, self.objetivo * FRACCION_INICIO)

    @property
    def validas(self) -> int:
        return sum(r.valida for r in self.repeticiones)

    @property
    def sostenido_ms(self) -> int:
        return self._sostenido_ms

    def actualizar(self, t_ms: int, amplitud: float | None) -> str | None:
        """Procesa un fotograma. Devuelve "rep_valida", "rep_incompleta" o None."""
        if amplitud is None:
            # Fotograma sin confianza: no se avanza ni se cuenta tiempo sostenido.
            self._t_anterior = None
            return None
        dt = 0 if self._t_anterior is None else t_ms - self._t_anterior
        self._t_anterior = t_ms

        if self.estado == "reposo":
            if amplitud > self.umbral_inicio:
                self._iniciar_repeticion()
                self.estado = "subiendo"
            else:
                return None

        self._pico = max(self._pico, amplitud)

        if self.estado == "subiendo":
            if amplitud >= self.umbral_objetivo:
                self.estado = "en_objetivo"
            elif amplitud < self.umbral_inicio - HISTERESIS:
                return self._cerrar()
        elif self.estado == "en_objetivo":
            if amplitud < self.umbral_objetivo - HISTERESIS:
                # Si ya sostuvo el tiempo, baja con la repetición cumplida; si no, puede reintentar.
                self.estado = "bajando" if self._cumplida else "subiendo"
                if not self._cumplida:
                    self._sostenido_ms = 0
            else:
                self._sostenido_ms += dt
                if self._sostenido_ms >= self.tiempo_sostenido_ms:
                    self._cumplida = True
        elif self.estado == "bajando":
            if amplitud < self.umbral_inicio - HISTERESIS:
                return self._cerrar()
        return None

    def _iniciar_repeticion(self) -> None:
        self._pico = 0.0
        self._sostenido_ms = 0
        self._cumplida = False

    def _cerrar(self) -> str:
        rep = Repeticion(len(self.repeticiones) + 1, round(self._pico, 1), self._sostenido_ms, self._cumplida)
        self.repeticiones.append(rep)
        self.estado = "reposo"
        self._sostenido_ms = 0
        return "rep_valida" if rep.valida else "rep_incompleta"
