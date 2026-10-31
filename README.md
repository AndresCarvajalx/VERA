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

Abrir http://localhost:8765 en Chrome o Edge. La cámara se elige en **Ajustes** (se guarda en
`data/ajustes.json`); la variable de entorno `CAMARA=1` la fija al arrancar.
Otra base de datos (p. ej. PostgreSQL): variable `BD_URL` con la URL de SQLAlchemy.

## Pantallas

| Pantalla | Qué hay | Código |
|---|---|---|
| Menú de inicio | Logo VERA (`web/logo.svg`, `web/favicon.svg`), Iniciar / Manual / Ajustes. Los personajes se asoman por las esquinas y los costados, saludan con un globo de diálogo, miran hacia el cursor y se esconden; si se les hace clic, saltan y responden | `web/mascotas.js` |
| Elige tu personaje | Los tres personajes en fila, cada uno en 3D; el elegido saluda. Abajo, quién juega y «¡A jugar!» | `web/vitrina.js`, `web/prueba.js` |
| Manual de usuario | Cómo se juega, preparación, cada ejercicio con una demostración 3D del rango normal, tabla de límites de movimiento de Kapandji (`GET /api/rangos`), etapas de la pierna y privacidad | `web/manual.js` |
| Ajustes | Cámaras del equipo (`GET /api/camara`), cambio de cámara o la de un celular por URL (`PUT /api/camara`, con IP Webcam o DroidCam; por USB aparece como otra cámara) y prueba en vivo con el esqueleto | `web/ajustes.js`, `vision/app/captura.py` |
| Sesión guiada | Todo avanza solo, con temporizadores (ver abajo). Arriba, los pasos 1 Calibrar · 2 Ejercicio · 3 Tu rango · 4 ¡A jugar!; siempre a mano Pausar y Detener | `web/flujo.js` |
| Panel del fisioterapeuta | Ejercicio, calibración y juego a mano, ángulos en vivo, medición de referencia con goniómetro y progreso | `web/prueba.js`, `web/escena3d.js` |

Solo la pantalla visible dibuja en 3D; las demás detienen su escena. Si la cámara nueva no abre, el
servicio vuelve a la anterior y responde 409.

## Flujo del jugador (sesión guiada, `web/flujo.js`)

Después de elegir personaje y jugador (código anónimo + consentimiento) no hace falta dar clics:
cada paso avanza solo con un temporizador, para que el jugador no tenga que acercarse al computador.

1. **«¡Bien! Ahora pasaremos a calibrar»** (cuenta de 5 s). Luego el jugador se queda de cuerpo
   completo frente a la cámara 3 s seguidos (si se sale del encuadre, el tiempo vuelve a empezar) →
   **«¡Calibrado!»**.
2. **«Selecciona el ejercicio»**: pierna y ejercicio, con el rango normal y el último rango del jugador.
3. **«Calibrando rangos de movimiento para X»** (cuenta de 5 s; `vision/app/calibracion.py`): de lado,
   quieto en la posición inicial (reposo) y el movimiento al máximo 3 veces mientras la guía 3D muestra
   el rango normal. Su rango es la mediana de los picos *sostenidos* (≥ 200 ms) de los intentos, que
   deben ser coherentes (≤ 8°). Si falla, reintenta solo a los 8 s.
4. La API calcula la meta (`vision/api/adaptacion.py`): 90 % del rango calibrado hoy, sube o baja 3°
   según las series, sin pasar lo calibrado + 10° ni el límite fisiológico. El jugador no ajusta
   ningún ángulo.
5. **«Prepárate para iniciar»**: cuenta regresiva de 5 a 0 y empieza la serie, con el contador de
   repeticiones y la **barra de ejecución**: va del reposo del jugador (0 %) a su meta (línea blanca al
   80 %), se pone verde en la meta y debajo se llena el tiempo que hay que sostenerla.
6. **Resultado**: repeticiones válidas, mejor ángulo y la próxima meta; a los 15 s vuelve solo a
   elegir ejercicio (o «Repetir» / «Terminar»).

Cada calibración y serie se guarda; «Mi progreso» (panel del fisioterapeuta) muestra el rango
calibrado de cada sesión. «Detener» está siempre visible y detiene todo.

Parámetros de calibración y adaptación: `config/reglas_rom.json` (decisiones de diseño a validar con
un fisioterapeuta).

## Personajes 3D elegibles

Cada jugador elige su personaje en la pantalla «Elige tu personaje»; se guarda con su código en la base
de datos y la guía usa el mismo personaje, como holograma.

| Personaje | Descripción | Rasgos |
|---|---|---|
| **Persona** (por defecto) | deportista de 1.70 m | una sola superficie suave (sin uniones), ropa de entrenamiento, pesos suaves en el esqueleto |
| Toribara | toro + capibara | cuernos, mechón, pezuñas |
| Conejibara | conejo + capibara | orejas largas, dientes, bigotes, cola de pompón, patas largas |

`modelado/generar_personajes.py` construye los tres en Blender con el mismo esqueleto (por eso el
juego los mueve con el mismo código, `web/toribara.js`). La persona se arma con formas solapadas que
luego se funden con un remallado por vóxeles, se suavizan, se reducen a ~27 000 caras, se visten por
zonas y se pegan al esqueleto con pesos automáticos; los capibaras son piezas rígidas. El script guarda
`modelado/<personaje>.blend` para retocarlo a mano y exporta `web/modelos/<personaje>.glb` y el
retrato `web/modelos/<personaje>.png`. Para agregar otro, se añade su especie en `ESPECIES` (script)
y en `PERSONAJES` (`vision/api/rutas.py`).

```powershell
& "D:\steam\steamapps\common\Blender\blender.exe" --background --factory-startup --python modelado\generar_personajes.py
```

Si se retoca un `.blend`, se exporta de nuevo a `web/modelos/<personaje>.glb` (glTF binario) conservando
los nombres de huesos, de objetos `venda_*` / `banda_entrenador` y de materiales `pelaje_pierna_*`:
el juego depende de ellos. La pierna del jugador muestra una de cuatro etapas según su rango
calibrado frente al normal: vendada (< 40 %), quitándose la venda (< 70 %), fortaleciéndose (< 90 %)
y en plena forma.

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

**Sesión completa sin cámara** (`vision/herramientas/jugador_simulado.py`): arranca el servicio real
en http://localhost:8766 con un jugador simulado en lugar de la cámara y de MediaPipe. Es un cuerpo de
perfil, con un rango limitado (rodilla hasta 95°), que reacciona al juego: se queda quieto en el
encuadre y en el reposo, hace los intentos de la calibración y las repeticiones (una de cada cuatro se
queda corta). Usa una base de datos y una carpeta de trazas temporales: no toca `data/`.

```powershell
.\.venv\Scripts\python vision\herramientas\jugador_simulado.py
```

Probado de principio a fin: encuadre → «¡Calibrado!» → ejercicio → calibración (rango 0–93.8°) →
meta adaptada 84° (90 %) → cuenta 5…0 → 5 de 6 repeticiones válidas → próxima meta 87° → vuelve solo
a elegir ejercicio. El navegador debe tener la página a la vista: las pestañas en segundo plano no
dibujan cuadros.

## Privacidad

El fotograma solo existe en memoria dentro del servicio de visión. Por el WebSocket viajan únicamente
landmarks, ángulos y eventos; el video no se guarda ni se envía. La base de datos guarda solo
ángulos e indicadores asociados a un código anónimo, y no acepta sesiones sin consentimiento vigente.
