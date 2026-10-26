# Reglas de rango de movimiento (ROM) — Miembro inferior

> Archivo de reglas para Claude Code. Define los rangos de movimiento articular de una **persona adulta general (sin patología)** para los 4 ejercicios del videojuego, y cómo medirlos con estimación de pose 2D. Úsalo como fuente única de verdad para umbrales, validaciones y mensajes.

---

## 1. Principios (obligatorios)

1. **Los valores de este archivo son límites fisiológicos de referencia, no metas terapéuticas.** La meta de cada paciente la define su fisioterapeuta. El juego debe permitir configurarla por usuario y **nunca** exigir más que el máximo de referencia.
2. **Todos los ángulos se expresan en grados, como ángulo clínico** (0° = posición de referencia anatómica), no como el ángulo interno entre segmentos que devuelve el cálculo vectorial. Ver sección 4.
3. **Fuente principal:** Kapandji, *Fisiología articular, Tomo 2: Miembro inferior* (6.ª ed., Editorial Médica Panamericana). Los valores clínicos generales (columna "Referencia clínica") sirven de contraste.
4. **El rango depende de la posición.** La flexión de rodilla depende de si la cadera está flexionada o extendida, y la de cadera de si la rodilla está flexionada o extendida. Cada ejercicio usa el valor que corresponde a **su** posición (sección 3).
5. **Un ángulo por encima del máximo fisiológico + tolerancia no es "mejor desempeño"**: es error de detección o compensación. La repetición no se cuenta y se muestra un aviso (sección 5).
6. El sistema **no diagnostica** ni evalúa la condición motriz general. Solo verifica si el movimiento alcanza el umbral configurado.

---

## 2. Rangos de movimiento de referencia

| Articulación | Movimiento | Condición | Activo (Kapandji) | Pasivo (Kapandji) | Referencia clínica |
|---|---|---|---|---|---|
| Rodilla | Flexión | Cadera flexionada | ~140° | ~160° (talón toca el glúteo) | 0–135° |
| Rodilla | Flexión | Cadera extendida (de pie) | ~120° (los isquiotibiales pierden eficacia) | — | — |
| Rodilla | Extensión | Desde cualquier flexión hasta la posición de referencia | 0° (rara vez la supera) | Hiperextensión 5–10° | 0° |
| Cadera | Flexión | Rodilla flexionada | ~120° | >140° (muslo casi contra el tórax) | 0–120° |
| Cadera | Flexión | Rodilla extendida | ~90° | >120° | — |
| Tobillo | Flexión dorsal (dorsiflexión) | Planta perpendicular a la pierna = 0° | 20–30° (variación ±10°) | — | 0–20° |
| Tobillo | Flexión plantar (referencia) | — | 30–50° (variación >20°) | — | 0–50° |

Notas:
- Kapandji señala que en la flexión de rodilla con la cadera extendida, una contracción balística puede superar los 120°.
- En el tobillo, las articulaciones del tarso añaden algunos grados en los extremos del movimiento.
- Durante la marcha normal solo se usan unos 10° de dorsiflexión y 15° de flexión plantar (Stauffer et al., 1977). Sirve de referencia de "rango funcional mínimo".

---

## 3. Reglas por ejercicio

Valores en grados clínicos. `max_fisiologico` es el techo absoluto; `meta_por_defecto` se usa solo si el fisioterapeuta no configuró una meta y **debe poder cambiarse**.

### 3.1 Rodilla · Doblar — Flexión de rodilla (talón hacia atrás), de pie
- Articulación medida: rodilla (cadera–rodilla–tobillo).
- Posición: de pie, cadera extendida → aplica el valor **activo con cadera extendida: ~120°**.
- `inicio`: ≤ 10° (pierna estirada).
- `meta_por_defecto`: 90°.
- `max_fisiologico`: 120°.
- Compensación a vigilar: flexión de cadera (el muslo se adelanta). Si la flexión de cadera del mismo lado supera 20° durante la repetición, se marca "mantén el muslo vertical".

### 3.2 Rodilla · Estirar — Extensión de rodilla, sentado
- Articulación medida: rodilla (cadera–rodilla–tobillo).
- Posición: sentado. La rodilla parte de ~90° de flexión y se extiende hacia 0°.
- `inicio`: ≥ 80° de flexión.
- `meta_por_defecto`: ≤ 10° de flexión (casi recta).
- `min_fisiologico`: −10° (hiperextensión pasiva máxima). Valores más negativos = error de detección.
- La repetición se cuenta cuando la flexión baja hasta la meta y vuelve a ≥ 60°.

### 3.3 Cadera · Doblar — Flexión de cadera (subir la rodilla), de pie
- Articulación medida: cadera (hombro–cadera–rodilla).
- Posición: de pie con la rodilla flexionada → aplica el valor **activo con rodilla flexionada: ~120°**.
- `inicio`: ≤ 10°.
- `meta_por_defecto`: 90° (muslo horizontal).
- `max_fisiologico`: 120°.
- Compensación a vigilar: inclinación del tronco hacia atrás o retroversión pélvica. Si el tronco se desvía más de 15° de la vertical, se marca "mantén el tronco recto".

### 3.4 Tobillo · Doblar — Dorsiflexión (subir la punta del pie), de pie
- Articulación medida: tobillo (rodilla–tobillo–punta del pie).
- Posición: de pie, apoyado en el talón.
- `inicio`: 0° ± 5° (planta apoyada).
- `meta_por_defecto`: 15°.
- `max_fisiologico`: 30° (Kapandji: 20–30°). Los valores clínicos usan 20° como normal.
- Compensación a vigilar: flexión de rodilla o desplazamiento del cuerpo hacia atrás. Si la flexión de rodilla supera 15°, se marca "mantén la rodilla estirada".
- Advertencia: el pie es un segmento corto y es el más ruidoso en la pose 2D. Ver la tolerancia de la sección 5.

---

## 4. Cómo calcular los ángulos (pose 2D, MediaPipe Pose)

Índices de puntos clave de MediaPipe (izquierda/derecha): hombro 11/12, cadera 23/24, rodilla 25/26, tobillo 27/28, talón 29/30, punta del pie 31/32.

```ts
// Ángulo interno en B (grados) entre los vectores BA y BC
function angle(A, B, C): number {
  const v1 = { x: A.x - B.x, y: A.y - B.y };
  const v2 = { x: C.x - B.x, y: C.y - B.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

// Conversión a ángulo clínico (0° = posición anatómica)
const kneeFlexion = 180 - angle(hip, knee, ankle);       // 0° recta, ~120° doblada de pie
const hipFlexion  = 180 - angle(shoulder, hip, knee);    // 0° de pie, 90° muslo horizontal
// Tobillo: ángulo entre pierna (tobillo→rodilla) y pie (talón→punta). Neutro = 90°.
const ankleDorsiflexion = 90 - angleBetween(vec(ankle, knee), vec(heel, footIndex)); // + = dorsiflexión
```

Reglas de cálculo:
- **Plano y cámara:** los 4 ejercicios son de flexión-extensión (plano sagital). La cámara debe ver al usuario **de lado**, porque una vista frontal no permite medir estos ángulos. Verifica la orientación al inicio de la sesión.
- Usa solo puntos clave con `visibility ≥ 0.6`. Si alguno de los 3 puntos no la cumple, el fotograma se descarta y no se actualiza el contador.
- Suaviza el ángulo con una media móvil de 5 fotogramas (o un filtro equivalente) antes de comparar con los umbrales.
- Mide siempre el lado que ve la cámara. El lado se define al inicio de la sesión.

---

## 5. Validaciones y tolerancias

| Regla | Valor | Acción |
|---|---|---|
| Tolerancia de medición 2D | ±10° | Margen sobre los límites fisiológicos antes de declarar error |
| Ángulo > `max_fisiologico` + 10° | — | Descartar el fotograma y mostrar "no te veo bien, revisa el encuadre". No cuenta repetición |
| Ángulo < `min_fisiologico` − 10° | — | Igual que el anterior |
| Meta configurada > `max_fisiologico` | — | Rechazar la configuración y avisar al usuario o al fisioterapeuta |
| Repetición efectiva | inicio → meta (± 5°) → inicio | Se cuenta solo si se cumplen las tres fases y no hubo una compensación activa |
| Salto de ángulo entre fotogramas > 30° | — | Tratarlo como ruido y no usarlo para cambiar de fase |
| Dolor | — | Botón de "parar" siempre visible; recordar al inicio que se detenga ante dolor o malestar |

---

## 6. Objeto de configuración sugerido

```json
{
  "knee_flexion_standing": { "joint": "knee", "landmarks": ["hip", "knee", "ankle"], "position": "standing", "start_max": 10, "default_goal": 90, "physio_max": 120, "physio_min": -10, "compensation": { "hip_flexion_max": 20 } },
  "knee_extension_seated": { "joint": "knee", "landmarks": ["hip", "knee", "ankle"], "position": "seated", "start_min": 80, "default_goal": 10, "goal_direction": "down", "physio_max": 140, "physio_min": -10 },
  "hip_flexion_standing": { "joint": "hip", "landmarks": ["shoulder", "hip", "knee"], "position": "standing", "start_max": 10, "default_goal": 90, "physio_max": 120, "physio_min": -20, "compensation": { "trunk_tilt_max": 15 } },
  "ankle_dorsiflexion_standing": { "joint": "ankle", "landmarks": ["knee", "ankle", "heel", "foot_index"], "position": "standing", "start_range": [-5, 5], "default_goal": 15, "physio_max": 30, "physio_min": -50, "compensation": { "knee_flexion_max": 15 } },
  "measurement_tolerance": 10,
  "min_visibility": 0.6,
  "smoothing_window": 5
}
```

---

## 7. Fuentes

- Kapandji, A. I. (2012). *Fisiología articular, Tomo 2: Miembro inferior* (6.ª ed.). Editorial Médica Panamericana. Valores tomados a través de:
  - Miranda Fisioterapia, "Movimiento de flexoextensión y rotación axial de la rodilla" (rodilla; cita a Kapandji, 2007, pp. 72–75).
  - Miranda Fisioterapia, "Flexo-extensión y complejo articular del tobillo" (tobillo; cita a Kapandji, 2012).
  - Wikipedia, "Articulación de la cadera" (cadera; cita a Kapandji, 5.ª ed.).
- Valores clínicos de referencia (cadera 0–120°, rodilla 0–135°, dorsiflexión 0–20°, flexión plantar 0–50°): Enlyte, "Understanding normal range of motion".
- Rango funcional en la marcha: Stauffer, Chao y Brewster (1977), *Clin Orthop*, citado en *Monografías SEMCPT* 14 (2022).
- Las tolerancias, las metas por defecto y los umbrales de compensación de las secciones 3, 5 y 6 son **decisiones de diseño del proyecto**, no valores de la literatura. Deben validarse con un fisioterapeuta.
