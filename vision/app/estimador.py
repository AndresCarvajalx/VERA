"""Interfaz EstimadorPose: el resto del sistema no depende de MediaPipe.

Para cambiar de modelo basta con escribir otra clase con el método `detectar`.
"""
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np


@dataclass
class Landmark:
    x: float  # normalizado 0–1 respecto al ancho de la imagen
    y: float  # normalizado 0–1 respecto al alto
    z: float  # profundidad relativa a la cadera (misma escala que x)
    visibilidad: float  # 0–1


@dataclass
class Pose:
    landmarks: list[Landmark]  # en la imagen: para ángulos, encuadre y el esqueleto 2D
    # En metros, con origen en el centro de la cadera (x a la derecha de la imagen, y hacia
    # abajo, z hacia el fondo). Solo se usan para mover el avatar 3D, no para medir.
    mundo: list[tuple[float, float, float]]


class EstimadorPose(Protocol):
    def detectar(self, fotograma_bgr: np.ndarray, t_ms: int) -> Pose | None:
        """Devuelve los 33 puntos del cuerpo, o None si no hay persona."""
        ...

    def cerrar(self) -> None: ...


# El modelo trabaja sobre un recorte reducido de la persona: una imagen más grande que esto (la
# cámara de un celular llega a 1920×1080) solo gasta tiempo en convertirla y copiarla.
LADO_MAXIMO = 960
# Con poca luz la detección pierde confianza: por debajo de este brillo medio (0–255) se aclara la
# imagen con una curva gamma antes de pasarla al modelo. No cambia la geometría, solo el contraste.
BRILLO_BAJO, BRILLO_OBJETIVO, GAMMA_MINIMA = 70.0, 110.0, 0.45


def preparar_imagen(fotograma_bgr: np.ndarray, _tablas: dict = {}) -> np.ndarray:
    """Fotograma BGR de la cámara → RGB listo para el modelo (reducido y aclarado si hace falta)."""
    import cv2

    alto, ancho = fotograma_bgr.shape[:2]
    if max(alto, ancho) > LADO_MAXIMO:
        escala = LADO_MAXIMO / max(alto, ancho)
        fotograma_bgr = cv2.resize(fotograma_bgr, (round(ancho * escala), round(alto * escala)),
                                   interpolation=cv2.INTER_AREA)
    brillo = float(fotograma_bgr[::8, ::8].mean())  # una muestra de 1 de cada 64 píxeles basta
    if 1.0 <= brillo < BRILLO_BAJO:
        gamma = max(GAMMA_MINIMA, round(np.log(BRILLO_OBJETIVO / 255) / np.log(brillo / 255), 2))
        if gamma not in _tablas:
            _tablas[gamma] = (np.linspace(0, 1, 256) ** gamma * 255).astype(np.uint8)
        fotograma_bgr = cv2.LUT(fotograma_bgr, _tablas[gamma])
    return cv2.cvtColor(fotograma_bgr, cv2.COLOR_BGR2RGB)


class EstimadorMediaPipe:
    def __init__(self, ruta_modelo: Path) -> None:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self._mp = mp
        opciones = vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(ruta_modelo)),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
            # Por defecto 0.5: con eso tarda en volver a encontrar a la persona al entrar en cuadro.
            # Bajar la detección acelera el reingreso; el seguimiento se deja en 0.5 para no
            # aceptar poses falsas. Valores a ajustar en las pruebas del OE4.
            min_pose_detection_confidence=0.3,
            min_pose_presence_confidence=0.3,
            min_tracking_confidence=0.5,
        )
        self._detector = vision.PoseLandmarker.create_from_options(opciones)
        self._ultimo_t = -1

    def detectar(self, fotograma_bgr: np.ndarray, t_ms: int) -> Pose | None:
        # El modo VIDEO exige marcas de tiempo estrictamente crecientes.
        t_ms = max(t_ms, self._ultimo_t + 1)
        self._ultimo_t = t_ms
        rgb = preparar_imagen(fotograma_bgr)
        imagen = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        resultado = self._detector.detect_for_video(imagen, t_ms)
        if not resultado.pose_landmarks:
            return None
        return Pose(
            landmarks=[
                Landmark(p.x, p.y, p.z, p.visibility if p.visibility is not None else 0.0)
                for p in resultado.pose_landmarks[0]
            ],
            mundo=[(p.x, p.y, p.z) for p in resultado.pose_world_landmarks[0]],
        )

    def cerrar(self) -> None:
        self._detector.close()
