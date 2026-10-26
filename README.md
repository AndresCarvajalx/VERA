# Videojuego de rehabilitación AMC — prototipo

Trabajo de grado, Ingeniería de Sistemas, Unitrópico (2026).

## Estructura

| Carpeta | Contenido |
|---|---|
| `vision/app` | Servicio de visión local: cámara → MediaPipe Pose → filtro One Euro → vista lateral y encuadre → ángulos clínicos → reglas ROM → WebSocket |
| `vision/api` | API de datos (FastAPI + SQLAlchemy, SQLite en `data/`): jugadores, consentimiento, metas, sesiones, resultados y progreso. Montada en `/api` |
| `config/reglas_rom.json` | Reglas de rango de movimiento por ejercicio: única fuente de umbrales (resumen de `docs/reglas_rango_movimiento_miembro_inferior.md`) |
| `vision/tests` | Pruebas de ángulos clínicos, reglas, repeticiones, evaluación y API |
| `vision/herramientas` | Medición de rendimiento (cámara y modelo por separado) |
| `web` | Cliente web: página de prueba, escena 3D (`escena3d.js`), avatar del jugador (`avatar.js`) y avatar guía (`guia.js`) |
| `web/vendor` | Three.js r160 (licencia MIT), copia local para funcionar sin internet |

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
Otra base de datos (p. ej. PostgreSQL): variable `BD_URL` con la URL de SQLAlchemy.

## Flujo del jugador

1. Elegir o crear el jugador (código anónimo + consentimiento).
2. Elegir ejercicio y pierna; ponerse **de lado** con esa pierna hacia la cámara (regla 4).
3. **Evaluar mi rango** (15 s): mide el rango inicial; se guarda como línea base.
4. **Jugar**: repeticiones contra la meta (por defecto la de las reglas; la aprueba el fisioterapeuta).
5. Al terminar cada evaluación o serie el resultado se guarda y «Mi progreso» muestra el avance.

## Pruebas

```powershell
cd vision; ..\.venv\Scripts\python -m pytest
```

## Privacidad

El fotograma solo existe en memoria dentro del servicio de visión. Por el WebSocket viajan únicamente
landmarks, ángulos y eventos; el video no se guarda ni se envía. La base de datos guarda solo
ángulos e indicadores asociados a un código anónimo, y no acepta sesiones sin consentimiento vigente.
