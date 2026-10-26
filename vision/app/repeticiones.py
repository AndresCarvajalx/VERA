"""Conteo de repeticiones con máquina de estados e histéresis.

    preparacion → reposo → subiendo → en_objetivo → bajando → reposo

Trabaja sobre un valor `v` que crece hacia la meta: el ángulo clínico en los ejercicios
"arriba" y el ángulo con signo cambiado en los "abajo" (p. ej. estirar la rodilla).

Repetición efectiva (regla 5): inicio → meta (± tolerancia) → inicio, sostenida el tiempo
configurado y sin compensaciones activas. Si no, queda incompleta (no se penaliza).
"""
from dataclasses import dataclass, field

HISTERESIS = 3.0  # grados: evita que el temblor alrededor de un umbral cuente doble


@dataclass
class Repeticion:
    numero: int
    angulo_pico: float  # el mejor valor de la repetición, ya como ángulo clínico
    sostenido_ms: int
    valida: bool
    motivo: str | None  # por qué no fue válida: "no_llego", "no_sostuvo", "compensacion"


@dataclass
class ContadorRepeticiones:
    umbral_meta: float  # v desde el que se considera alcanzada la meta
    umbral_inicio: float  # v por debajo del cual el jugador está en la posición inicial
    umbral_arranque: float  # v que hay que alcanzar antes de la primera repetición
    tiempo_sostenido_ms: int = 0
    signo: int = 1  # para devolver el pico como ángulo clínico (v = signo · ángulo)
    estado: str = "preparacion"
    repeticiones: list[Repeticion] = field(default_factory=list)
    _pico: float = float("-inf")
    _sostenido_ms: int = 0
    _cumplida: bool = False
    _compensada: bool = False
    _t_anterior: int | None = None

    @property
    def validas(self) -> int:
        return sum(r.valida for r in self.repeticiones)

    @property
    def sostenido_ms(self) -> int:
        return self._sostenido_ms

    def actualizar(self, t_ms: int, v: float | None, compensando: bool = False) -> str | None:
        """Procesa un fotograma. Devuelve "rep_valida", "rep_incompleta" o None."""
        if v is None:
            # Fotograma descartado: no avanza ni suma tiempo sostenido.
            self._t_anterior = None
            return None
        dt = 0 if self._t_anterior is None else t_ms - self._t_anterior
        self._t_anterior = t_ms

        if self.estado == "preparacion":
            if v <= self.umbral_arranque:
                self.estado = "reposo"
            return None

        if self.estado == "reposo":
            if v <= self.umbral_inicio + HISTERESIS:
                return None
            self._pico, self._sostenido_ms = float("-inf"), 0
            self._cumplida = self._compensada = False
            self.estado = "subiendo"

        self._pico = max(self._pico, v)
        self._compensada = self._compensada or compensando

        if v <= self.umbral_inicio:
            return self._cerrar()  # volvió al inicio: termina la repetición, cumplida o no
        if self.estado == "subiendo":
            if v >= self.umbral_meta:
                self.estado = "en_objetivo"
        elif self.estado == "en_objetivo":
            if v < self.umbral_meta - HISTERESIS:
                # Si ya sostuvo el tiempo, vuelve con la meta cumplida; si no, puede reintentar.
                self.estado = "bajando" if self._cumplida else "subiendo"
                if not self._cumplida:
                    self._sostenido_ms = 0
            else:
                self._sostenido_ms += dt
                if self._sostenido_ms >= self.tiempo_sostenido_ms:
                    self._cumplida = True
        return None

    def _cerrar(self) -> str:
        if self._compensada:
            motivo = "compensacion"
        elif self._cumplida:
            motivo = None
        elif self._pico >= self.umbral_meta:
            motivo = "no_sostuvo"
        else:
            motivo = "no_llego"
        rep = Repeticion(len(self.repeticiones) + 1, round(self.signo * self._pico, 1),
                         self._sostenido_ms, motivo is None, motivo)
        self.repeticiones.append(rep)
        self.estado = "reposo"
        self._sostenido_ms = 0
        return "rep_valida" if rep.valida else "rep_incompleta"
