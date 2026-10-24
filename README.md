# Videojuego de rehabilitación AMC — prototipo

Trabajo de grado, Ingeniería de Sistemas, Unitrópico (2026).

## Estructura

| Carpeta | Contenido |
|---|---|
| `vision/app` | Servicio de visión local: cámara → MediaPipe Pose → filtro One Euro → encuadre → ángulos → WebSocket |
| `vision/tests` | Pruebas unitarias de ángulos, encuadre y filtro |
| `vision/herramientas` | Medición de rendimiento (cámara y modelo por separado) |
| `web` | Cliente web (por ahora, página de prueba del Paso 1) |

## Instalación (Windows)

```powershell
py -3.12 -m venv .venv   # o la ruta a python.exe 3.12
.\.venv\Scripts\python -m pip install -r vision\requirements.txt
Invoke-WebRequest "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task" -OutFile vision\models\pose_landmarker_full.task
```

## Ejecutar

```powershell
.\.venv\Scripts\python -m uvicorn app.servicio:app --app-dir vision --port 8765
```

Abrir http://localhost:8765 en Chrome o Edge. Otra cámara: variable de entorno `CAMARA=1`.

## Pruebas

```powershell
cd vision; ..\.venv\Scripts\python -m pytest
```

## Privacidad

El fotograma solo existe en memoria dentro del servicio de visión. Por el WebSocket viajan únicamente
landmarks, ángulos y eventos; el video no se guarda ni se envía.
