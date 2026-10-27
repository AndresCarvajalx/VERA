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
3. **Calibrar** (`vision/app/calibracion.py`): la guía 3D muestra el rango de una persona sin
   limitación; el jugador queda quieto (reposo) y hace el movimiento al máximo 3 veces. Su rango es la
   mediana de los picos *sostenidos* (≥ 200 ms) de los intentos, que deben ser coherentes (≤ 8°).
4. **Jugar**: el jugador no ajusta ningún ángulo. La API calcula la meta (`vision/api/adaptacion.py`):
   90 % del rango calibrado hoy, sube o baja 3° según las series, sin pasar lo calibrado + 10° ni el
   límite fisiológico. Si hoy no calibró, «Jugar» calibra primero y arranca el juego solo.
5. Cada calibración y serie se guarda; «Mi progreso» muestra el rango calibrado de cada sesión.

Parámetros de calibración y adaptación: `config/reglas_rom.json` (decisiones de diseño a validar con
un fisioterapeuta).

## Precisión de la calibración con datos reales

Cada calibración guarda su traza de ángulos (sin imágenes ni código del jugador) en `data/trazas/`.
Para medir la repetibilidad y recalcular con los parámetros actuales:

```powershell
cd vision; ..\.venv\Scripts\python herramientas\analizar_calibraciones.py
```

Primeras trazas reales (flexión de rodilla de pie, pierna derecha): 116.4° y 113.7°, desviación 1.9°,
sin signos invertidos; dos de ellas están en `vision/tests/datos/` como pruebas de regresión.

## Pruebas

```powershell
cd vision; ..\.venv\Scripts\python -m pytest
```

## Privacidad

El fotograma solo existe en memoria dentro del servicio de visión. Por el WebSocket viajan únicamente
landmarks, ángulos y eventos; el video no se guarda ni se envía. La base de datos guarda solo
ángulos e indicadores asociados a un código anónimo, y no acepta sesiones sin consentimiento vigente.
