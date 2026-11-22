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
| Elige tu personaje | Los cuatro personajes en fila, cada uno en 3D; el elegido saluda. Abajo, quién juega y «¡A jugar!» | `web/vitrina.js`, `web/prueba.js` |
| Mi progreso | Tiempo jugado por día, mejoría del rango por ejercicio y pierna, periodo de 7 días, 30 días o todo, y descarga en CSV (`GET /api/pacientes/<código>/diario`) | `web/mi_progreso.js`, `web/progreso.js` |
| Manual de usuario | Cómo se juega, preparación, cada ejercicio con una demostración 3D del rango normal, tabla de límites de movimiento de Kapandji (`GET /api/rangos`), etapas de la pierna y privacidad | `web/manual.js` |
| Ajustes | Cámaras del equipo (`GET /api/camara`), cambio de cámara o la de un celular por URL (`PUT /api/camara`, con IP Webcam o DroidCam; por USB aparece como otra cámara) y prueba en vivo con el esqueleto | `web/ajustes.js`, `vision/app/captura.py` |
| Sesión guiada | Todo avanza solo, con temporizadores (ver abajo). Arriba, los pasos 1 Calibrar · 2 Ejercicio · 3 Tu rango · 4 ¡A jugar!; siempre a mano Pausar y Detener | `web/flujo.js` |
| Panel del fisioterapeuta | Ejercicio, calibración y juego a mano, ángulos en vivo, medición de referencia con goniómetro y progreso | `web/prueba.js`, `web/escena3d.js` |

El fondo de estrellas (`web/estrellas.js`) cubre todas las pantallas: en el menú se viaja entre ellas y
cruzan estrellas fugaces, en las demás se mueven despacio y durante el ejercicio quedan quietas para no
quitarle fluidez a la escena 3D. Con «reducir movimiento» activado en el sistema, no se animan.

En el menú, el fondo suma nubes de color y un horizonte de rejilla de neón que avanza hacia el jugador.
El decorado del juego (`web/escenario.js`) tiene cielo con degradado, una ciudad de neón a lo lejos con
ventanas encendidas, haces de luz que barren el cielo y niebla, y rodea al jugador y a la guía: piso con rejilla, una plataforma y un
foco por personaje, barras de luz y un arco al fondo, partículas y sombras. Destella cuando una repetición
sale bien o perfecta. Las piezas de neón tienen halo de resplandor, los personajes reflejan una luz de entorno
(`web/efectos3d.js`), y con cada repetición perfecta la guía festeja y sale confeti. Al terminar la serie se
dan de 1 a 3 estrellas: 3 si todas contaron y pasaron la meta, 2 si contó al menos el 70 %. En el tema profesional queda en su versión sobria, sin partículas ni focos.

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

«Detener» está siempre visible y detiene todo.

**Ejercicios sentado:** el ángulo se mide en la imagen, así que la silla debe quedar de perfil a la
cámara. Solo se empieza a medir de perfil y con el muslo horizontal, y si el jugador se gira hacia la
cámara más de 1 s la medición se detiene hasta que vuelva a quedar de perfil. Con el muslo horizontal,
él es quien indica hacia dónde mira el jugador (la cabeza suele girarse hacia la pantalla).

**Subir la punta del pie:** el talón debe seguir en el piso. Al subir toda la pierna el pie también cambia
de ángulo, así que el servicio vigila la altura del talón: si sube más de 15 % del largo de la pierna
(`talon_apoyado` en `config/reglas_rom.json`, unos 6 cm; a validar con un fisioterapeuta) la repetición o el
intento de calibración no cuenta y se le pide que lo apoye.

## Seguimiento de la pose (`vision/app/seguimiento.py`)

Entre el estimador y la medición de ángulos, `SeguidorPose` convierte las detecciones sueltas de cada
fotograma en un rastro estable. Se prueba con poses sintéticas (`vision/tests/test_seguimiento.py`).

| Problema | Qué hace | Medido (sintético) |
|---|---|---|
| Retraso en movimientos rápidos | Filtro One Euro que se abre con la rapidez (`beta` 0,05 → 12) | 141 ms → 16 ms a 0,5 imagen/s; el temblor en reposo sigue ~64 % menor que la lectura cruda |
| Parpadeo de puntos en el umbral | Visibilidad promediada en el tiempo y con histéresis de 0,08 | Un tobillo que oscila entre 0,56 y 0,64 ya no entra y sale de la medición |
| Puntos tapados que bailan | Cuanto menos visible el punto, más despacio se mueve | Menos de la mitad del movimiento del punto adivinado |
| Persona perdida unos fotogramas | Se sostiene la última pose hasta 200 ms | — |
| Falsos positivos | Se descarta una detección sin puntos confiables o que aparece de golpe a más de un largo de tronco | — |

En el estimador (`preparar_imagen`): las imágenes de más de 960 px (cámara de un celular) se reducen
antes de la inferencia y las oscuras (brillo medio < 70/255) se aclaran con una curva gamma. El mensaje
de cada fotograma lleva `proceso_ms` (detección + medición). `MODELO_POSE=lite|full|heavy` elige el modelo.

**Límites:** es una cámara web con MediaPipe Pose, no un sistema de varias cámaras: la precisión es de
grados, no de milímetros, y estos cambios no se han validado todavía con cámara real ni con goniómetro.

## Temas e iconos

En **Ajustes → Apariencia** se elige entre el tema actual (neón) y el **tema profesional**
(`web/tema_profesional.css`): sobrio, sin estrellas, mascotas ni brillos, con tipografía del sistema, y
que sigue el modo claro u oscuro del equipo. El escenario 3D queda siempre oscuro. La elección se guarda
en el navegador (`web/tema.js`) y un script en línea la aplica antes de pintar.

No hay emojis en la interfaz: los iconos son SVG en línea definidos como variables `--icono-*` en
`web/prueba.css` y pintados como máscara sobre el color del texto, así sirven en cualquier tema.

## Racha, logros y voz

- **Racha:** días seguidos jugando (`GET /api/pacientes/<código>/logros`). Sigue viva si el último día jugado
  fue hoy o ayer. Aparece en la barra de la sesión y en **Mi progreso**, con la mejor racha.
- **Logros:** nueve medallas calculadas de lo guardado (primera serie, serie sin fallos, 3 y 7 días seguidos,
  10 series, +5° y +15° de rango, los cuatro ejercicios, 30 minutos). Los que faltan muestran su avance;
  al ganar uno aparece un aviso en la sesión.
- **Voz que guía** (`web/voz.js`): lee en voz alta las instrucciones de cada paso, los avisos y por qué una
  repetición no contó. Solo habla con una voz en español (si no hay ninguna, se calla) y elige la de mejor
  calidad: las «naturales» de Microsoft Edge, luego las de Google en Chrome, luego las de Windows. En
  **Ajustes** se elige otra o se apaga; el botón de silencio también la calla.

## Informe en PDF

En **Mi progreso → Informe (PDF)** se arma un informe del periodo elegido (`web/informe.js`) y se abre el diálogo
de impresión del navegador: «Guardar como PDF». Trae un resumen (días, tiempo, series, repeticiones, racha y
logros), el rango medido por ejercicio y pierna con su gráfica, el detalle por día y cómo se midió. **VERA no
tiene fines de diagnóstico clínico**: el informe lo dice al principio y al final, y solo describe lo medido.

## Indicadores del OE4 e informe técnico

- **Encuesta SUS** (`web/encuesta.js`, `POST/GET /api/pacientes/<código>/sus`): las diez afirmaciones de la System
  Usability Scale, de 1 a 5, con puntaje de 0 a 100. Se ofrece en el resultado de la serie mientras el jugador no la
  haya respondido. No pregunta nada de salud.
- **Rendimiento:** la latencia (cámara → pantalla, promedio y p95) y los FPS se miden ahora también en la sesión
  guiada y se guardan en la sesión después de cada resultado.
- **Informe técnico (PDF)** en el panel del fisioterapeuta (`GET /api/indicadores`): error frente al goniómetro,
  FPS, latencia y SUS de todos los jugadores, con su meta (≤ 10°, ≥ 15 FPS, ≤ 200 ms, ≥ 68) y cómo se midió.
  Ojo: incluye a los jugadores de prueba y los datos inventados de BRAYAN.

## Calentamiento, tutorial, escenarios y música

- **Tutorial** (`web/tutorial.js`): cinco tarjetas la primera vez que un jugador entra a la sesión; también en el Manual.
- **Calentamiento:** antes de calibrar, la guía hace tres movimientos suaves de 15 s cada uno; se puede saltar.
- **Escenarios** (`web/escenario.js`): ciudad de neón desde el inicio, playa al atardecer a los 3 días jugados y
  espacio a los 7 (días en total, no seguidos). Se eligen en «Elige tu personaje».
- **Música con ritmo** (`web/sonido.js`): en el ejercicio, una capa de bombo y arpegio sube mientras el jugador se
  mueve y baja en reposo.

## Sonido

`web/sonido.js` crea la música y los efectos en el navegador con Web Audio: no hay archivos de audio, así
que funciona sin internet y no hay licencias que citar. Suena desde el primer clic o tecla (regla de los
navegadores). El botón de la esquina silencia todo; los volúmenes están en **Ajustes** y se guardan en
este navegador.

- **Música:** una pista alegre en los menús y otra lenta y baja en la sesión y el panel.
- **Efectos:** cuenta regresiva, «te veo», cada intento, calibración lista y serie completa.
- **Cada repetición** suena según su `calidad`, que calcula el servicio (`vision/app/repeticiones.py`):

| Calidad | Cuándo | En pantalla |
|---|---|---|
| `perfecto` | válida y pasó la meta | ¡PERFECTO! |
| `bien` | válida, dentro de la tolerancia de la meta | ¡BIEN! |
| `casi` | no sostuvo el tiempo, o hizo ≥ 75 % del recorrido hasta la meta (`fraccion_casi` en `config/reglas_rom.json`, a validar con un fisioterapeuta) | ¡CASI! |
| `mal` | hizo menos de eso, o compensó con otra parte del cuerpo | ¡SIGUE! |

## Progreso diario

Con varias páginas abiertas, solo la que pidió la actividad guarda su resultado.

Cada calibración y serie se guarda en la base de datos (`data/amc.sqlite3`) al terminar, con su fecha
y su duración. **Mi progreso**, desde el menú, lo agrupa por día del equipo:

- **Tiempo jugado:** solo el tiempo en movimiento (`duracion_s`), sin pausas ni la espera de ponerse
  de lado. Las calibraciones fallidas o detenidas suman tiempo, pero no cuentan como rango medido.
- **Mejoría:** el rango calibrado de cada día (su última calibración), por ejercicio y pierna, frente
  al rango normal.
- **Datos antiguos:** lo guardado antes de medir la duración aparece como «sin dato»; su tiempo no se
  estima. Una actividad cortada al cerrar la página no alcanza a guardarse.
- **Descargar datos (CSV):** un renglón por día, con separador «;» y coma decimal para abrirlo en Excel.

El panel del fisioterapeuta conserva el detalle por sesión.

Parámetros de calibración y adaptación: `config/reglas_rom.json` (decisiones de diseño a validar con
un fisioterapeuta).

## Personajes 3D elegibles

En el juego los personajes se dibujan en estilo caricatura (`web/estilo_toon.js`): sombreado por bandas y un
contorno oscuro que sigue al esqueleto. La guía no lo usa: es un holograma translúcido.

Cada jugador elige su personaje en la pantalla «Elige tu personaje»; se guarda con su código en la base
de datos y la guía usa el mismo personaje, como holograma.

| Personaje | Descripción | Rasgos |
|---|---|---|
| **Persona** (por defecto) | deportista de 1.70 m | una sola superficie suave (sin uniones), ropa de entrenamiento, pesos suaves en el esqueleto; ojos con blanco e iris, sonrisa, mejillas, flequillo, pulgares y suela de color |
| Mujer | deportista de 1.65 m | la misma construcción que la persona, con sus propias proporciones y cola de caballo |
| Toribara | toro + capibara | cuernos, mechón, pezuñas |
| Conejibara | conejo + capibara | orejas largas, dientes, bigotes, cola de pompón, patas largas |

`modelado/generar_personajes.py` construye los cuatro en Blender con el mismo esqueleto (por eso el
juego los mueve con el mismo código, `web/toribara.js`). Las personas se arman con formas solapadas que
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
