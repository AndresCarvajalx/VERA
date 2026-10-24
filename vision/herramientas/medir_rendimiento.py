"""Mide por separado la cámara y el estimador de pose, para saber dónde está el cuello de botella.

Uso (desde la carpeta vision):  ..\\.venv\\Scripts\\python herramientas\\medir_rendimiento.py
"""
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.estimador import EstimadorMediaPipe  # noqa: E402

MODELOS = Path(__file__).resolve().parents[1] / "models"
N = 60


def medir_camara(backend: int, nombre: str):
    cam = cv2.VideoCapture(0, backend)
    cam.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cam.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cam.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    for _ in range(5):
        cam.read()
    t0 = time.perf_counter()
    fotogramas = []
    for _ in range(N):
        ok, f = cam.read()
        if ok:
            fotogramas.append(f)
    dt = time.perf_counter() - t0
    print(f"Cámara {nombre}: {len(fotogramas) / dt:.1f} FPS, brillo medio {fotogramas[-1].mean():.0f}/255,"
          f" exposición {cam.get(cv2.CAP_PROP_EXPOSURE)}")
    cam.release()
    return fotogramas


def medir_modelo(archivo: str, fotogramas) -> None:
    ruta = MODELOS / archivo
    if not ruta.exists():
        print(f"{archivo}: no descargado")
        return
    est = EstimadorMediaPipe(ruta)
    est.detectar(fotogramas[0], 0)
    t0 = time.perf_counter()
    for i, f in enumerate(fotogramas):
        est.detectar(f, (i + 1) * 33)
    ms = (time.perf_counter() - t0) / len(fotogramas) * 1000
    print(f"{archivo}: {ms:.0f} ms por fotograma (máx. {1000 / ms:.0f} FPS)")
    est.cerrar()


if __name__ == "__main__":
    medir_camara(cv2.CAP_DSHOW, "DSHOW")
    fotogramas = medir_camara(cv2.CAP_MSMF, "MSMF")
    for modelo in ("pose_landmarker_lite.task", "pose_landmarker_full.task"):
        medir_modelo(modelo, fotogramas)
