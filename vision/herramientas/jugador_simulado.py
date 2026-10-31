"""Servicio completo con un jugador simulado en lugar de la cámara, para probar la sesión guiada de
principio a fin sin nadie frente a la cámara.

Todo es lo real (vista lateral, ángulos, filtros, calibración, conteo de repeticiones, API, plan
adaptado y página web) menos MediaPipe: los 33 puntos los genera un cuerpo de perfil con ángulos
conocidos (tests/cuerpo.py) que reacciona a lo que el juego le pide:

- sin actividad: de pie y quieto, de cuerpo completo y de lado (pierna derecha hacia la cámara);
- calibrando: quieto en el reposo y luego intentos hasta su rango máximo (con ±2° de variación);
- jugando: repeticiones que pasan la meta y, cada cuarta, una que se queda corta («¡CASI!»).

Su rango es el de alguien con limitación (ROM_SIMULADO), para ver que el juego se adapta a él.
Usa una base de datos y una carpeta de trazas temporales: no toca data/.

    .\\.venv\\Scripts\\python -m herramientas.jugador_simulado      (desde vision/)
    → http://localhost:8766
"""
import math
import os
import random
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np

RAIZ = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RAIZ / "vision"))
TEMPORAL = Path(tempfile.mkdtemp(prefix="vera_simulado_"))
os.environ["BD_URL"] = f"sqlite:///{(TEMPORAL / 'simulado.sqlite3').as_posix()}"

from app import captura, servicio, trazas  # noqa: E402
from app.estimador import Landmark, Pose  # noqa: E402
from tests.cuerpo import ALTO, ANCHO, cuerpo_lateral  # noqa: E402

PUERTO = 8766
# Hasta dónde llega el jugador simulado (grados clínicos): menos que una persona sin limitación.
ROM_SIMULADO = {
    "knee_flexion_standing": 95.0,
    "hip_flexion_standing": 95.0,
    "ankle_dorsiflexion_standing": 22.0,
    "knee_extension_seated": 15.0,  # estira hasta dejar la rodilla a 15° (no llega a recta)
}
REPOSO_MS, SUBIR_MS, SOSTENER_MS, BAJAR_MS = 1800, 800, 1200, 800


class CamaraSimulada:
    """Entrega fotogramas negros a ~30 FPS: el estimador simulado no los mira."""

    def isOpened(self):
        return True

    def read(self):
        time.sleep(1 / 30)
        return True, np.zeros((ALTO, ANCHO, 3), np.uint8)

    def set(self, *_):
        return True

    def release(self):
        pass


def pose_de(ejercicio: str | None, grados: float) -> dict:
    """Ángulos del cuerpo para el ejercicio, `grados` desde la posición inicial."""
    if ejercicio == "hip_flexion_standing":
        return {"cadera": grados, "rodilla": grados}  # la rodilla sube con la pierna colgando
    if ejercicio == "ankle_dorsiflexion_standing":
        return {"tobillo": grados}
    if ejercicio == "knee_extension_seated":
        return {"cadera": 90.0, "rodilla": 90.0 - grados}  # sentado, estira desde 90°
    return {"rodilla": grados}


class JugadorSimulado:
    def __init__(self) -> None:
        self.bucle = None  # se enlaza al arrancar el servicio
        self._inicio_actividad = None
        self._actividad = None
        self._rep = 0
        self._pico = 0.0

    def cerrar(self) -> None:
        pass

    def _objetivo(self, act) -> float:
        """Amplitud de la repetición actual desde la posición inicial."""
        clave = act.regla.clave
        maximo = ROM_SIMULADO[clave] if act.regla.direccion == "arriba" else 90.0 - ROM_SIMULADO[clave]
        if act.tipo == "calibracion":
            return maximo + random.uniform(-2, 0)
        meta = act.meta if act.regla.direccion == "arriba" else 90.0 - act.meta
        if self._rep % 4 == 3:
            return max(5.0, meta - 15)  # se queda corta
        return min(maximo, meta + 3)

    def _grados(self, act, t_ms: int) -> float:
        if act is not self._actividad:
            self._actividad, self._inicio_actividad, self._rep = act, None, 0
        # Empieza a moverse cuando el servicio ya lo ve de lado (como haría una persona).
        if not act.vista_ok:
            return 0.0
        self._inicio_actividad = self._inicio_actividad or t_ms
        ciclo = REPOSO_MS + SUBIR_MS + SOSTENER_MS + BAJAR_MS
        u = (t_ms - self._inicio_actividad) % ciclo
        rep = (t_ms - self._inicio_actividad) // ciclo
        if rep != self._rep or not self._pico:
            self._rep, self._pico = rep, self._objetivo(act)
        suave = lambda x: 0.5 - 0.5 * math.cos(math.pi * x)
        if u < REPOSO_MS:
            return 0.0
        u -= REPOSO_MS
        if u < SUBIR_MS:
            return self._pico * suave(u / SUBIR_MS)
        u -= SUBIR_MS
        if u < SOSTENER_MS:
            return self._pico
        return self._pico * (1 - suave((u - SOSTENER_MS) / BAJAR_MS))

    def detectar(self, _fotograma, t_ms: int) -> Pose:
        act = self.bucle._controlador.actividad if self.bucle else None
        ejercicio = act.regla.clave if act else None
        grados = self._grados(act, t_ms) if act else 0.0
        lms = cuerpo_lateral(**pose_de(ejercicio, grados), lado="der", mira=1)
        # Brazos colgando junto al tronco (cuerpo_lateral solo arma la cabeza y las piernas).
        for hombro, codo, muneca in ((11, 13, 15), (12, 14, 16)):
            h = lms[hombro]
            lms[codo] = Landmark(h.x, h.y + 70 / ALTO, h.z, h.visibilidad)
            lms[muneca] = Landmark(h.x + 0.01, h.y + 135 / ALTO, h.z, h.visibilidad)
        # Puntos en metros con origen en la cadera; el lado de atrás, 0.2 m más lejos.
        mundo = [((p.x * ANCHO - 300) / 260, (p.y * ALTO - 230) / 260, 0.1 if p.z > 0 else -0.1) for p in lms]
        return Pose(lms, mundo)


def main() -> None:
    import uvicorn

    jugador = JugadorSimulado()
    captura.abrir_captura = lambda _fuente: CamaraSimulada()
    servicio.EstimadorMediaPipe = lambda _modelo: jugador
    trazas.DIRECTORIO = TEMPORAL / "trazas"
    trazas.guardar.__defaults__ = (trazas.DIRECTORIO,)

    original = servicio.ciclo_de_vida

    @asynccontextmanager
    async def ciclo(app):
        async with original(app):
            jugador.bucle = servicio.bucle
            yield

    servicio.app.router.lifespan_context = ciclo
    print(f"Jugador simulado listo: http://localhost:{PUERTO}  (datos temporales en {TEMPORAL})")
    uvicorn.run(servicio.app, host="127.0.0.1", port=PUERTO, log_level="warning")


if __name__ == "__main__":
    main()
