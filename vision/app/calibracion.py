"""Calibración: mide el rango de movimiento real del jugador en un ejercicio.

1. Reposo: el jugador queda quieto en la posición inicial; la mediana de esa ventana es su
   reposo (si se mueve más de lo permitido, la ventana se vuelve a medir).
2. Intentos: hace el movimiento lo más que puede, varias veces. Cada intento empieza al
   alejarse `umbral_intento` grados del reposo y termina al volver. Su valor es el *pico
   sostenido*: el mayor ángulo que mantuvo al menos `sostenido_ms`, lo que descarta los
   picos de un solo fotograma (ruido del estimador).
   Si más tarde el jugador queda quieto en una posición claramente más cercana al inicio que el
   reposo medido (p. ej. empezó con la rodilla ya doblada, imitando a la guía), el reposo se
   corrige a esa posición y los intentos se vuelven a medir desde ahí. Caso real: una traza con
   el reposo tomado en 108° de flexión cuando la pierna recta estaba en 0–7°.
3. Resultado: la mediana de los mejores `intentos` picos. Se exige que sean coherentes
   (dispersión ≤ `dispersion_max`); si tras `intentos_max` no lo son, se entrega igual,
   marcada como poco consistente.

Trabaja con v = signo · ángulo, que crece hacia la meta del ejercicio (signo −1 en "abajo").
Parámetros: config/reglas_rom.json → "calibracion".
"""
import statistics
from collections import deque

from .reglas import ParametrosCalibracion


class Calibracion:
    def __init__(self, parametros: ParametrosCalibracion, signo: int) -> None:
        self.p = parametros
        self.signo = signo
        self.fase = "reposo"
        self.t_inicio: int | None = None
        self.reposo_v: float | None = None
        self.picos_v: list[float] = []
        self._ventana: deque[tuple[int, float]] = deque()  # reposo o intento en curso
        self._ventana_baja: deque[tuple[int, float]] = deque()  # posible reposo más cercano al inicio
        self.reanclajes = 0
        self._en_intento = False
        self._pico_actual: float | None = None
        self._vistos: list[float] = []
        # Todos los fotogramas recibidos (t, ángulo o None): permiten revisar la precisión
        # con datos reales (herramientas/analizar_calibraciones.py). Solo números, sin imágenes.
        self.traza: list[tuple[int, float | None]] = []

    # --- medición -------------------------------------------------------------
    def actualizar(self, t_ms: int, angulo: float | None) -> tuple[str, dict | str] | None:
        """Procesa un fotograma. Devuelve ("lista", resumen), ("fallida", motivo) o None."""
        if self.t_inicio is None:
            self.t_inicio = t_ms
        self.traza.append((t_ms, angulo))
        if angulo is not None:
            self._vistos.append(angulo)
            v = self.signo * angulo
            if self.fase == "reposo":
                self._medir_reposo(t_ms, v)
            else:
                self._medir_intento(t_ms, v)
        elif self._en_intento:
            self._ventana.clear()  # un hueco rompe la continuidad del pico sostenido

        if self.fase == "intentos" and not self._en_intento and self._terminada():
            return "lista", self.resumen()
        if t_ms - self.t_inicio >= self.p.tiempo_max_ms:
            if self.picos_v:
                return "lista", self.resumen()
            return "fallida", "sin_reposo" if self.reposo_v is None else "sin_intentos"
        return None

    def _quieto(self, ventana: deque, t_ms: int, v: float) -> float | None:
        """Agrega el valor a la ventana; si cubre `reposo_ms` sin moverse, devuelve su mediana."""
        ventana.append((t_ms, v))
        while ventana and t_ms - ventana[0][0] > self.p.reposo_ms:
            ventana.popleft()
        valores = [x for _, x in ventana]
        if t_ms - ventana[0][0] >= self.p.reposo_ms * 0.9 and len(valores) >= 5 \
                and statistics.pstdev(valores) <= self.p.reposo_desviacion_max:
            return statistics.median(valores)
        return None

    def _medir_reposo(self, t_ms: int, v: float) -> None:
        reposo = self._quieto(self._ventana, t_ms, v)
        if reposo is not None:
            self.reposo_v = reposo
            self.fase = "intentos"
            self._ventana.clear()

    def _medir_intento(self, t_ms: int, v: float) -> None:
        distancia = v - self.reposo_v
        if not self._en_intento and distancia < -self.p.umbral_intento:
            # Quieto bastante más cerca del inicio que el reposo medido: ese era el verdadero reposo.
            reposo = self._quieto(self._ventana_baja, t_ms, v)
            if reposo is not None:
                # Los picos ya medidos se conservan: son ángulos absolutos y superaron un umbral
                # más exigente que el del nuevo reposo.
                self.reposo_v = reposo
                self.reanclajes += 1
                self._ventana_baja.clear()
            return
        self._ventana_baja.clear()
        if not self._en_intento:
            if distancia > self.p.umbral_intento:
                self._en_intento, self._pico_actual = True, None
                self._ventana.clear()
            else:
                return
        if distancia < self.p.umbral_intento / 2:  # volvió al reposo: termina el intento
            if self._pico_actual is not None:
                self.picos_v.append(self._pico_actual)
            self._en_intento = False
            self._ventana.clear()
            return
        # Pico sostenido: el mínimo de la última ventana de `sostenido_ms` es lo que se mantuvo.
        self._ventana.append((t_ms, v))
        while len(self._ventana) > 1 and t_ms - self._ventana[1][0] >= self.p.sostenido_ms:
            self._ventana.popleft()
        if t_ms - self._ventana[0][0] >= self.p.sostenido_ms:
            sostenido = min(x for _, x in self._ventana)
            self._pico_actual = sostenido if self._pico_actual is None else max(self._pico_actual, sostenido)

    def _mejores(self) -> list[float]:
        return sorted(self.picos_v, reverse=True)[: self.p.intentos]

    def _terminada(self) -> bool:
        mejores = self._mejores()
        if len(mejores) >= self.p.intentos and max(mejores) - min(mejores) <= self.p.dispersion_max:
            return True
        return len(self.picos_v) >= self.p.intentos_max

    # --- resultados -----------------------------------------------------------
    def resumen(self) -> dict:
        mejores = self._mejores()
        mejor = self.signo * statistics.median(mejores)
        reposo = self.signo * self.reposo_v
        dispersion = max(mejores) - min(mejores)
        return {
            "mejor": round(mejor, 1),
            "reposo": round(reposo, 1),
            "rango": round(abs(mejor - reposo), 1),
            "angulo_max": round(max(self._vistos), 1),
            "angulo_min": round(min(self._vistos), 1),
            "intentos": [round(self.signo * p, 1) for p in self.picos_v],
            "dispersion": round(dispersion, 1),
            "consistente": len(mejores) >= self.p.intentos and dispersion <= self.p.dispersion_max,
            "reanclajes": self.reanclajes,
        }

    def estado(self, t_ms: int) -> dict:
        """Lo que la pantalla necesita para guiar al jugador durante la calibración."""
        if self.fase == "reposo":
            progreso_reposo = 0.0
            if self._ventana:
                progreso_reposo = min(1.0, (t_ms - self._ventana[0][0]) / self.p.reposo_ms)
            return {"paso": "reposo", "progreso": round(0.2 * progreso_reposo, 2), "intentos": 0,
                    "intentos_necesarios": self.p.intentos}
        pico = None if self._pico_actual is None or not self._en_intento else round(self.signo * self._pico_actual, 1)
        return {
            "paso": "intentos",
            "progreso": round(0.2 + 0.8 * min(1.0, len(self.picos_v) / self.p.intentos), 2),
            "reposo": round(self.signo * self.reposo_v, 1),
            "intentos": len(self.picos_v),
            "intentos_necesarios": self.p.intentos,
            "picos": [round(self.signo * p, 1) for p in self.picos_v],
            "en_intento": self._en_intento,
            "pico_actual": pico,
        }
