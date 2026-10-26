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
        import cv2

        # El modo VIDEO exige marcas de tiempo estrictamente crecientes.
        t_ms = max(t_ms, self._ultimo_t + 1)
        self._ultimo_t = t_ms
        rgb = cv2.cvtColor(fotograma_bgr, cv2.COLOR_BGR2RGB)
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
