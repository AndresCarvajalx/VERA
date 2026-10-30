// Página del prototipo: jugador, evaluación inicial de rango, juego con las reglas ROM,
// guardado de resultados en la base de datos y progreso. El video nunca llega al navegador:
// todo se dibuja con los puntos que envía el servicio de visión.
import { Escena3D } from "./escena3d.js";
import { dibujarProgreso } from "./progreso.js";
import { etapaPorAvance } from "./toribara.js";

const CONEXIONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],          // tronco
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], // pierna izquierda
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], // pierna derecha
  [11, 13], [13, 15], [12, 14], [14, 16],          // brazos
];
const MIEMBRO_INFERIOR = new Set([23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
const UMBRAL_VISIBILIDAD = 0.6; // config/reglas_rom.json
const LADOS = { der: "derecha", izq: "izquierda" };
const POSICION = { de_pie: "de pie", sentado: "sentado" };
// Cómo demuestra la guía cada ejercicio del catálogo.
const GUIA = {
  knee_flexion_standing: { articulacion: "rodilla", sentido: 1 },
  knee_extension_seated: { articulacion: "rodilla", sentido: -1 },
  hip_flexion_standing: { articulacion: "cadera", sentido: 1 },
  ankle_dorsiflexion_standing: { articulacion: "tobillo", sentido: 1 },
};

const $ = (id) => document.getElementById(id);
const lienzo = $("lienzo");
const ctx = lienzo.getContext("2d");
const latencias = [];
const estado = {
  ejercicios: {}, jugador: null, progreso: [], plan: null, sesionId: null, pasoGuia: null, finActividad: 0,
  jugarTrasCalibrar: false, latenciaSuma: 0, latenciaN: 0,
};

function color(nombre) {
  return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
}

// --- API de datos -------------------------------------------------------------
async function api(metodo, url, cuerpo) {
  const r = await fetch(`/api${url}`, {
    method: metodo,
    headers: cuerpo ? { "Content-Type": "application/json" } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new Error(typeof datos?.detail === "string" ? datos.detail : `Error ${r.status}`);
  return datos;
}

function recordar(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch { /* sin almacenamiento: no pasa nada */ }
}
function recuperar(clave) {
  try { return localStorage.getItem(clave); } catch { return null; }
}

// --- esqueleto 2D -------------------------------------------------------------
function dibujar(msg) {
  const [ancho, alto] = msg.imagen;
  if (lienzo.width !== ancho) { lienzo.width = ancho; lienzo.height = alto; }
  ctx.clearRect(0, 0, ancho, alto);
  if (!msg.landmarks.length) return;
  const p = (i) => [(1 - msg.landmarks[i][0]) * ancho, msg.landmarks[i][1] * alto]; // espejo
  const visible = (i) => msg.landmarks[i][3] >= UMBRAL_VISIBILIDAD;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (const [a, b] of CONEXIONES) {
    if (!visible(a) || !visible(b)) continue;
    ctx.strokeStyle = MIEMBRO_INFERIOR.has(a) && MIEMBRO_INFERIOR.has(b) ? color("--acento") : color("--suave");
    ctx.beginPath(); ctx.moveTo(...p(a)); ctx.lineTo(...p(b)); ctx.stroke();
  }
  for (let i = 11; i < msg.landmarks.length; i++) {
    ctx.fillStyle = visible(i) ? color("--texto") : color("--mal");
    ctx.beginPath(); ctx.arc(...p(i), 5, 0, Math.PI * 2); ctx.fill();
  }
}

// --- panel en vivo ------------------------------------------------------------
const NOMBRES = { hombro: "hombro", cadera: "cadera", rodilla: "rodilla", tobillo: "tobillo", talon: "talón", pie: "pie" };

function textoAviso(msg) {
  if (!msg.persona) return "No te veo: ubícate de cuerpo completo frente a la cámara";
  const partes = msg.faltan.map((clave) => {
    const [parte, lado] = clave.split("_");
    return `${NOMBRES[parte]} ${lado === "der" ? "derecho" : "izquierdo"}`;
  });
  return `No se ve: ${partes.join(", ")}`;
}

function actualizarPanel(msg) {
  const latencia = Date.now() - msg.t_captura; // t_render − t_captura (mismo reloj del equipo)
  latencias.push(latencia);
  if (latencias.length > 30) latencias.shift();
  estado.latenciaSuma += latencia; estado.latenciaN += 1;
  const lectura = lecturaEstable(`${$("ref_articulacion").value}_${$("ref_lado").value}`);
  $("ref_sistema").textContent = !lectura ? "– (no se ve la articulación)"
    : `${lectura.mediana.toFixed(1)}° ${lectura.desviacion <= 3 ? "· estable" : `· se mueve (±${lectura.desviacion.toFixed(1)}°)`}`;
  $("fps").textContent = msg.fps.toFixed(1);
  const lento = msg.fps > 0 && msg.fps < 15; // meta del OE4
  $("fps").style.color = lento ? color("--mal") : "";
  $("aviso_fps").classList.toggle("oculto", !lento);
  $("latencia").textContent = `${Math.round(latencias.reduce((a, b) => a + b, 0) / latencias.length)} ms`;
  $("encuadre").textContent = msg.encuadre_ok ? "OK" : "No";
  $("encuadre").style.color = msg.encuadre_ok ? color("--ok") : color("--mal");
  $("aviso").classList.toggle("oculto", msg.encuadre_ok);
  if (!msg.encuadre_ok) $("aviso").textContent = textoAviso(msg);
  for (const clave of ["cadera", "rodilla", "tobillo"].flatMap((a) => [`${a}_izq`, `${a}_der`])) {
    const v = msg.angulos[clave];
    $(clave).textContent = v == null ? "–" : `${v.toFixed(0)}°`;
  }
  const actividad = msg.calibracion ?? msg.rep;
  actualizarVista(msg, actividad);
  $("aviso_compensacion").classList.toggle("oculto", !actividad?.compensacion);
  if (actividad?.compensacion) $("aviso_compensacion").textContent = actividad.compensacion;
  // Un fotograma capturado antes de que la calibración terminara puede dibujarse después del
  // evento de fin: se ignora para no reactivar la guía de calibración.
  if (msg.calibracion && msg.t_captura > estado.finActividad) actualizarCalibracion(msg.calibracion);
  actualizarReto(msg.rep);
}

function actualizarCalibracion(c) {
  $("progreso_calibracion").style.width = `${c.progreso * 100}%`;
  // Mientras se mide el reposo la guía queda quieta en la posición inicial: si se mueve, el
  // jugador tiende a imitarla y empieza ya doblado (pasó en una calibración real).
  const pasoGuia = c.fase === "verificando_vista" || c.paso === "reposo" ? "inicial" : "normal";
  if (estado.pasoGuia !== pasoGuia) {
    estado.pasoGuia = pasoGuia;
    mostrarGuia(pasoGuia);
  }
  const angulo = c.angulo == null ? "" : ` · ahora ${c.angulo.toFixed(0)}°`;
  const inicial = seleccion().regla?.posicion_inicial ?? "en la posición inicial";
  let texto;
  if (c.fase === "verificando_vista") texto = `Ponte de lado, ${inicial}…`;
  else if (c.fase === "pausado") texto = "Calibración en pausa.";
  else if (c.paso === "reposo") texto = `Paso 1: quédate quieto ${inicial}${angulo}`;
  else {
    const n = Math.min(c.intentos + 1, c.intentos_necesarios);
    const hechos = c.picos.length ? ` · tus intentos: ${c.picos.map((p) => `${p.toFixed(0)}°`).join(", ")}` : "";
    texto = c.en_intento
      ? `Intento ${n}: ¡más! Mantén el máximo un momento${c.pico_actual == null ? "" : ` (${c.pico_actual.toFixed(0)}°)`}`
      : `Paso 2: intento ${n} de ${c.intentos_necesarios} — haz el movimiento lo más que puedas${hechos}`;
  }
  $("estado_calibracion").textContent = texto;
}

function actualizarVista(msg, actividad) {
  const aviso = $("aviso_vista");
  const esperando = actividad?.fase === "verificando_vista";
  aviso.classList.toggle("oculto", !esperando);
  if (!esperando) return;
  const pierna = LADOS[actividad.lado];
  aviso.textContent = !msg.vista?.lateral
    ? `Ponte de lado, con tu pierna ${pierna} hacia la cámara`
    : `Gírate: la cámara debe ver tu pierna ${pierna}`;
}

const ESTADOS = {
  preparacion: "Ponte en la posición inicial", reposo: "Listo, empieza", subiendo: "Vas bien…",
  en_objetivo: "¡Sostén!", bajando: "Vuelve despacio",
};
const FASES = { pausado: "En pausa", no_visible: "No veo esa pierna", verificando_vista: "Ponte de lado" };

function actualizarReto(rep) {
  $("reto").classList.toggle("oculto", !rep);
  $("hud").classList.toggle("oculto", !rep);
  if (!rep) return;
  // La barra avanza hacia la meta: en "abajo" (estirar) avanza cuando el ángulo baja.
  const arriba = rep.direccion === "arriba";
  const escala = arriba ? rep.max_fisiologico : 100;
  const avance = (v) => (arriba ? v : escala - v);
  const pct = (v) => `${Math.max(0, Math.min(100, (avance(v) / escala) * 100))}%`;
  const enMeta = rep.estado === "en_objetivo" || rep.estado === "bajando";
  $("barra_amplitud").style.width = rep.angulo == null ? "0" : pct(rep.angulo);
  $("barra_amplitud").classList.toggle("en_objetivo", enMeta);
  $("marca_objetivo").style.left = pct(rep.umbral_meta);
  // Medidor vertical del escenario: la meta queda siempre al 75 % de la altura.
  const alto = (v) => `${Math.max(0, Math.min(100, (75 * avance(v)) / Math.max(1, avance(rep.umbral_meta))))}%`;
  $("hud_relleno").style.height = rep.angulo == null ? "0" : alto(rep.angulo);
  $("hud_relleno").classList.toggle("en_objetivo", enMeta);
  $("hud_meta").style.bottom = "75%";
  $("hud_reps").replaceChildren(String(rep.validas), Object.assign(document.createElement("small"), { textContent: `/${rep.repeticiones_meta}` }));
  $("hud_angulo").textContent = rep.angulo == null ? "–" : `${Math.round(rep.angulo)}°`;
  let texto = rep.fase === "midiendo" ? ESTADOS[rep.estado] ?? rep.estado : FASES[rep.fase] ?? rep.fase;
  if (rep.fase === "midiendo" && rep.estado === "en_objetivo" && rep.tiempo_sostenido_ms > 0) {
    texto += ` ${(rep.sostenido_ms / 1000).toFixed(1)} / ${(rep.tiempo_sostenido_ms / 1000).toFixed(1)} s`;
  }
  const angulo = rep.angulo == null ? "–" : `${rep.angulo.toFixed(0)}°`;
  $("reto_estado").textContent = `${texto} · ${angulo}`;
  $("reto_reps").textContent = `${rep.validas} / ${rep.repeticiones_meta}`;
  $("reto_maximo").textContent = rep.mejor == null ? "Mejor de la serie: –"
    : `Mejor de la serie: ${rep.mejor.toFixed(0)}° (meta ${rep.meta}°, cuenta desde ${rep.umbral_meta}°)`;
}

// --- medición de referencia (CU-14) -------------------------------------------
// Último segundo y medio de ángulos, guardado al llegar cada mensaje (no al dibujar), para
// comparar con el goniómetro la mediana de lo que midió el sistema mientras el jugador estaba quieto.
const historial = [];

function registrarAngulos(msg) {
  historial.push({ t: msg.t_captura, angulos: msg.angulos });
  while (historial.length && msg.t_captura - historial[0].t > 1500) historial.shift();
}

function lecturaEstable(clave) {
  const fin = historial.at(-1)?.t;
  const valores = historial.filter((h) => fin - h.t <= 1000).map((h) => h.angulos[clave]).filter((v) => v != null);
  if (valores.length < 8) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const mitad = orden.length >> 1;
  const mediana = orden.length % 2 ? orden[mitad] : (orden[mitad - 1] + orden[mitad]) / 2;
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const desviacion = Math.sqrt(valores.reduce((a, v) => a + (v - media) ** 2, 0) / valores.length);
  return { mediana, desviacion };
}

async function registrarReferencia() {
  if (!requiereJugador()) return;
  const articulacion = $("ref_articulacion").value, lado = $("ref_lado").value;
  const goniometro = Number($("ref_goniometro").value);
  const evaluador = $("ref_evaluador").value.trim();
  if ($("ref_goniometro").value === "" || !evaluador) {
    mostrarMensaje("Escribe el ángulo del goniómetro y quién mide.", "mal");
    return;
  }
  const lectura = lecturaEstable(`${articulacion}_${lado}`);
  if (!lectura) { mostrarMensaje("El sistema no ve esa articulación: revisa el encuadre.", "mal"); return; }
  if (lectura.desviacion > 3) { mostrarMensaje("El jugador se está moviendo: que sostenga la posición y vuelve a registrar.", "mal"); return; }
  try {
    await asegurarSesion();
    const r = await api("POST", `/sesiones/${estado.sesionId}/mediciones-referencia`, {
      articulacion, lado, angulo_goniometro: goniometro, angulo_sistema: Math.round(lectura.mediana * 10) / 10,
      dispersion_sistema: Math.round(lectura.desviacion * 10) / 10, evaluador,
    });
    mostrarMensaje(`Medición guardada: goniómetro ${goniometro}°, sistema ${lectura.mediana.toFixed(1)}° (error ${r.error > 0 ? "+" : ""}${r.error}°).`, "ok");
    $("ref_goniometro").value = "";
    await cargarPrecision();
  } catch (e) {
    mostrarMensaje(`No se pudo guardar la medición: ${e.message}`, "mal");
  }
}

async function cargarPrecision() {
  if (!estado.jugador) { $("ref_resumen").textContent = ""; return; }
  const p = await api("GET", `/pacientes/${encodeURIComponent(estado.jugador)}/precision`);
  if (!p.total) { $("ref_resumen").textContent = "Aún no hay mediciones de referencia para este jugador."; return; }
  const partes = Object.entries(p.por_articulacion).map(([a, r]) =>
    `${a}: error medio ${r.error_absoluto_medio}° (sesgo ${r.sesgo > 0 ? "+" : ""}${r.sesgo}°, n=${r.n})`);
  $("ref_resumen").textContent = `${partes.join(" · ")}. Total: ${p.total.error_absoluto_medio}° ` +
    `(${p.total.cumple_meta ? "cumple" : "no cumple"} la meta de ≤ ${p.meta}°).`;
}

function mostrarMensaje(texto, tipo = "") {
  const m = $("mensaje");
  m.textContent = texto;
  m.className = `mensaje ${tipo}`;
}

/** Texto grande y animado en el escenario ("¡PERFECTO!", "¡CASI!"...), con un destello de color. */
function celebrar(texto, clase) {
  for (const [id, base] of [["celebracion", "celebracion"], ["destello", "destello"]]) {
    const el = $(id);
    el.className = base;
    void el.offsetWidth; // reinicia la animación aunque la clase sea la misma
    el.className = `${base} ${clase} ver`;
  }
  $("celebracion").textContent = texto;
}

// --- jugador, ejercicio y plan adaptado ---------------------------------------
function seleccion() {
  const clave = $("sel_ejercicio").value;
  return { clave, regla: estado.ejercicios[clave], lado: $("sel_lado").value };
}

/** Rango de una persona sin limitación (reglas): techo en "arriba", pierna recta en "abajo". */
function rangoNormal(regla) {
  return regla.direccion === "arriba" ? regla.max_fisiologico : 0;
}

function actualizarEjercicio() {
  const { regla, lado } = seleccion();
  if (!regla) return;
  $("descripcion_ejercicio").textContent = regla.descripcion;
  $("instruccion_camara").textContent =
    `Posición: ${POSICION[regla.posicion]}. Ponte de lado, con tu pierna ${LADOS[lado]} hacia la cámara.`;
  estado.plan = null;
  mostrarGuia("normal");
  mostrarEtapasPierna();
  cargarPlan();
}

/**
 * La guía demuestra el rango normal mientras no hay plan (y durante la calibración), y la meta
 * adaptada del jugador cuando la hay.
 */
function mostrarGuia(modo) {
  const { clave, regla, lado } = seleccion();
  if (!regla) return;
  const usarMeta = modo === "meta" && estado.plan && !estado.plan.requiere_calibracion;
  const angulo = usarMeta ? estado.plan.meta : rangoNormal(regla);
  $("titulo_guia").textContent = modo === "inicial" ? "Guía · posición inicial"
    : usarMeta ? `Guía · tu meta ${angulo}°` : `Guía · rango normal ${angulo}°`;
  escena.mostrarEjercicio({
    ...GUIA[clave], lado,
    // La guía sentada parte de 90° de flexión y estira hasta el ángulo indicado; 0 = quieta.
    objetivo: modo === "inicial" ? 0 : regla.direccion === "arriba" ? angulo : Math.max(0, 90 - angulo),
    tiempo_sostenido_ms: 1000,
  });
}

async function cargarPlan() {
  const { clave, regla, lado } = seleccion();
  if (!estado.jugador || !regla) {
    $("plan_juego").textContent = "Elige un jugador para que el juego se adapte a su rango.";
    return null;
  }
  const params = new URLSearchParams({ ejercicio: clave, lado });
  if (estado.sesionId) params.set("sesion", estado.sesionId);
  const plan = await api("GET", `/pacientes/${encodeURIComponent(estado.jugador)}/plan?${params}`);
  estado.plan = plan;
  if (plan.requiere_calibracion) {
    $("plan_juego").textContent = "Aún no calibras este ejercicio hoy. Al pulsar «Jugar» primero se calibra.";
    mostrarGuia("normal");
    return plan;
  }
  const normal = `${plan.referencia}°`;
  const origen = plan.origen === "fisioterapeuta" ? "fijada por tu fisioterapeuta"
    : `${Math.round(100 * plan.fraccion_rango)} % de tu rango de hoy${plan.ajuste ? ` ${plan.ajuste > 0 ? "+" : ""}${plan.ajuste}° por cómo te ha ido` : ""}`;
  $("plan_juego").textContent = plan.jugable
    ? `Tu rango hoy: de ${plan.reposo}° a ${plan.calibrado}° (normal: ${normal}). Meta del juego: ${plan.meta}°, ${origen}. ` +
      `${plan.repeticiones} repeticiones.` + (plan.calibracion.consistente ? "" : " Tus intentos variaron mucho: si puedes, vuelve a calibrar.")
    : `Tu rango hoy (${plan.reposo}°–${plan.calibrado}°) es muy pequeño para contar repeticiones con fiabilidad. Coméntalo con tu fisioterapeuta.`;
  mostrarGuia("meta");
  return plan;
}

async function cargarJugadores(seleccionar) {
  const codigos = await api("GET", "/pacientes");
  const sel = $("sel_jugador");
  sel.replaceChildren(new Option("— elige —", ""), ...codigos.map((c) => new Option(c, c)));
  const elegido = seleccionar ?? recuperar("jugador");
  if (elegido && codigos.includes(elegido)) {
    sel.value = elegido;
    await elegirJugador(elegido);
  }
}

async function elegirJugador(codigo) {
  cerrarSesion();
  estado.jugador = codigo || null;
  estado.sesionId = null; // cada jugador tiene su propia sesión (y debe calibrar en ella)
  $("jugador_actual").textContent = codigo ? `Jugador ${codigo}` : "Sin jugador";
  $("jugador_actual").className = codigo ? "chip ok" : "chip";
  if (codigo) recordar("jugador", codigo);
  estado.progreso = codigo ? await api("GET", `/pacientes/${encodeURIComponent(codigo)}/progreso`) : [];
  pintarProgreso();
  actualizarEjercicio();
  cargarPrecision().catch(() => {});
}

async function cargarProgreso() {
  if (!estado.jugador) return;
  estado.progreso = await api("GET", `/pacientes/${encodeURIComponent(estado.jugador)}/progreso`);
  pintarProgreso();
}

function pintarProgreso() {
  const vacio = !estado.jugador ? "Elige un jugador para ver su progreso."
    : !estado.progreso.length ? "Todavía no hay calibraciones guardadas. Empieza con «Calibrar» o «Jugar»." : "";
  $("progreso_vacio").textContent = vacio;
  $("progreso_vacio").classList.toggle("oculto", !vacio);
  dibujarProgreso($("tarjetas_progreso"), estado.progreso, $("tooltip"));
  mostrarEtapasPierna();
}

const NOMBRE_ETAPA = {
  vendada: "vendada", venda_parcial: "quitándose la venda", fortaleciendose: "fortaleciéndose", en_forma: "en plena forma",
};

/**
 * La pierna del toribara refleja el rango calibrado del ejercicio elegido frente al normal de las
 * reglas (arriba: mejor / normal; abajo, estirar desde 90° sentado: lo estirado / 90). Una pierna
 * sin calibraciones de ese ejercicio se ve normal.
 */
function mostrarEtapasPierna() {
  const { clave, regla } = seleccion();
  const etapas = {}, textos = [];
  for (const lado of ["izq", "der"]) {
    const serie = estado.progreso.find((s) => s.ejercicio === clave && s.lado === lado);
    if (!serie || !regla) { etapas[lado] = null; continue; }
    const mejor = serie.ultimo.mejor;
    const fraccion = regla.direccion === "arriba" ? mejor / serie.referencia : (90 - mejor) / 90;
    etapas[lado] = etapaPorAvance(Math.max(0, Math.min(1, fraccion)));
    textos.push(`pierna ${LADOS[lado]} ${NOMBRE_ETAPA[etapas[lado]]} (${Math.round(100 * Math.min(1, fraccion))} % del rango normal)`);
  }
  escena.mostrarEtapas(etapas);
  $("rotulo_jugador").textContent = textos.length ? `Tú · ${textos.join(" · ")}` : "Tú";
}

async function guardarResumen(resumen) {
  if (!estado.jugador) {
    mostrarMensaje("No hay jugador elegido: este resultado no se guardó.", "mal");
    return;
  }
  try {
    await asegurarSesion();
    await api("POST", `/sesiones/${estado.sesionId}/resultados`, resumen);
    await cargarProgreso();
    await cargarPlan();
    return true;
  } catch (e) {
    mostrarMensaje(`No se pudo guardar: ${e.message}`, "mal");
    return false;
  }
}

async function asegurarSesion() {
  if (!estado.sesionId) estado.sesionId = (await api("POST", "/sesiones", { paciente: estado.jugador })).id;
}

function cerrarSesion() {
  if (!estado.sesionId || !estado.jugador) return;
  const latencia = estado.latenciaN ? estado.latenciaSuma / estado.latenciaN : null;
  fetch(`/api/sesiones/${estado.sesionId}`, {
    method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latencia_promedio_ms: latencia }),
  });
}

// --- comandos ---------------------------------------------------------------------
let ws = null;
let ultimo = null;

function enviar(nombre, datos = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: "comando", nombre, ...datos }));
  else mostrarMensaje("Sin conexión con el servicio de visión.", "mal");
}

function requiereJugador() {
  if (estado.jugador) return true;
  mostrarMensaje("Primero elige o crea un jugador: así se guarda su progreso.", "mal");
  return false;
}

const escena = new Escena3D($("escena3d"));

$("sel_jugador").addEventListener("change", (e) => elegirJugador(e.target.value).catch((err) => mostrarMensaje(err.message, "mal")));
$("sel_ejercicio").addEventListener("change", actualizarEjercicio);
$("sel_lado").addEventListener("change", actualizarEjercicio);

$("btn_crear_jugador").addEventListener("click", async () => {
  const codigo = $("nuevo_codigo").value.trim().toUpperCase();
  if (!$("nuevo_consentimiento").checked) {
    mostrarMensaje("Sin consentimiento informado no se pueden guardar datos del jugador.", "mal");
    return;
  }
  try {
    await api("POST", "/pacientes", { codigo, version_consentimiento: "v1", autoriza_datos_sensibles: true });
    $("nuevo_codigo").value = ""; $("nuevo_consentimiento").checked = false;
    $("btn_crear_jugador").closest("details").open = false;
    await cargarJugadores(codigo);
    mostrarMensaje(`Jugador ${codigo} creado.`, "ok");
  } catch (e) {
    mostrarMensaje(e.message.includes("pattern") || e.message.startsWith("Error 422")
      ? "El código debe tener de 3 a 20 letras, números o guiones (sin nombres ni espacios)." : e.message, "mal");
  }
});

function calibrar() {
  if (!requiereJugador()) return;
  const { clave, lado } = seleccion();
  // La guía espera quieta en la posición inicial; en los intentos muestra el rango normal.
  estado.pasoGuia = "inicial";
  mostrarGuia("inicial");
  const inicial = seleccion().regla.posicion_inicial;
  mostrarMensaje(`Calibración: ponte de lado, ${inicial}. Luego la guía te mostrará el rango normal; tú haz lo que puedas, sin dolor.`);
  $("estado_calibracion").textContent = `Ponte de lado, ${inicial}…`;
  enviar("calibrar", { ejercicio: clave, lado });
}

/** El jugador no ajusta ángulos: la meta y la dosificación vienen del plan adaptado. */
async function jugar() {
  if (!requiereJugador()) return;
  let plan;
  try {
    plan = await cargarPlan();
  } catch (e) {
    mostrarMensaje(e.message, "mal");
    return;
  }
  if (plan.requiere_calibracion) {
    estado.jugarTrasCalibrar = true;
    calibrar();
    return;
  }
  if (!plan.jugable) {
    mostrarMensaje("Tu rango de hoy es muy pequeño para este ejercicio. Coméntalo con tu fisioterapeuta.", "mal");
    return;
  }
  const { clave, lado } = seleccion();
  mostrarGuia("meta");
  mostrarMensaje(`¡A jugar! Tu meta es ${plan.meta}°.`, "ok");
  enviar("iniciar_ejercicio", {
    ejercicio: clave, lado, meta: plan.meta, repeticiones: plan.repeticiones,
    tiempo_sostenido_ms: plan.tiempo_sostenido_ms, reposo: plan.reposo,
  });
}

$("btn_calibrar").addEventListener("click", () => { estado.jugarTrasCalibrar = false; calibrar(); });
$("btn_jugar").addEventListener("click", jugar);
$("btn_registrar_referencia").addEventListener("click", registrarReferencia);

for (const boton of document.querySelectorAll("[data-comando]")) {
  boton.addEventListener("click", () => enviar(boton.dataset.comando));
}

// --- eventos del servicio -----------------------------------------------------------
const MOTIVOS_REP = { no_llego: "no llegaste a la meta", no_sostuvo: "no sostuviste el tiempo", compensacion: "hubo compensación" };

const FIN_DE_ACTIVIDAD = new Set(["calibracion_lista", "calibracion_fallida", "serie_completa", "ejercicio_detenido"]);

async function manejarEvento(msg) {
  registrarEvento(msg);
  if (FIN_DE_ACTIVIDAD.has(msg.nombre)) estado.finActividad = msg.t;
  switch (msg.nombre) {
    case "vista_ok":
      mostrarMensaje("¡Bien! Ya te veo de lado. Empieza.", "ok");
      break;
    case "comando_rechazado":
      mostrarMensaje(`No se pudo: ${msg.motivo}`, "mal");
      break;
    case "fuera_de_rango":
      mostrarMensaje(msg.mensaje, "mal");
      break;
    case "rep_valida": {
      // Superar la meta (no solo entrar en la tolerancia) se celebra como "perfecto".
      const plan = estado.plan;
      const supero = plan && (plan.direccion === "arriba" ? msg.angulo_pico >= plan.meta : msg.angulo_pico <= plan.meta);
      celebrar(supero ? "¡PERFECTO!" : "¡BIEN!", supero ? "perfecto" : "bien");
      mostrarMensaje(`¡Repetición ${msg.numero} válida! Llegaste a ${msg.angulo_pico}°`, "ok");
      break;
    }
    case "rep_incompleta":
      celebrar("¡CASI!", "casi");
      mostrarMensaje(`Repetición incompleta (${MOTIVOS_REP[msg.motivo] ?? msg.motivo}): llegaste a ${msg.angulo_pico}°. ¡Sigue!`);
      break;
    case "reposo_listo":
      mostrarMensaje(msg.corregido
        ? `Corregí tu posición inicial a ${msg.reposo}°. Sigue haciendo el movimiento al máximo.`
        : `Posición inicial registrada (${msg.reposo}°). Ahora haz el movimiento lo más que puedas.`, "ok");
      break;
    case "intento_calibracion":
      celebrar(`${Math.round(msg.angulo_pico)}°`, "bien");
      mostrarMensaje(`Intento ${msg.numero}: ${msg.angulo_pico}°. Vuelve a la posición inicial y repite.`, "ok");
      break;
    case "calibracion_fallida": {
      estado.jugarTrasCalibrar = false;
      estado.pasoGuia = null;
      mostrarGuia("normal");
      $("progreso_calibracion").style.width = "0";
      $("estado_calibracion").textContent = "";
      const motivo = msg.motivo === "sin_reposo"
        ? "no pudiste quedarte quieto en la posición inicial (o no se vio bien la pierna)"
        : "no se registró ningún intento completo";
      mostrarMensaje(`No pude calibrar: ${motivo}. Revisa la luz y el encuadre e inténtalo otra vez.`, "mal");
      break;
    }
    case "calibracion_lista": {
      const r = msg.resumen;
      estado.pasoGuia = null;
      $("progreso_calibracion").style.width = "0";
      $("estado_calibracion").textContent =
        `Tu rango hoy: de ${r.reposo}° a ${r.mejor}° (intentos: ${r.intentos.map((p) => `${p}°`).join(", ")}).`;
      if (!(await guardarResumen(r))) {
        estado.jugarTrasCalibrar = false;
        break;
      }
      celebrar("¡CALIBRADO!", "serie");
      mostrarMensaje(`Calibración guardada: tu rango es de ${r.reposo}° a ${r.mejor}°.` +
        (r.consistente ? "" : " Tus intentos variaron mucho; puedes repetir la calibración."), "ok");
      if (estado.jugarTrasCalibrar) {
        estado.jugarTrasCalibrar = false;
        setTimeout(jugar, 2500); // un respiro antes de empezar la serie
      }
      break;
    }
    case "serie_completa":
    case "ejercicio_detenido": {
      const r = msg.resumen;
      // Una calibración interrumpida no es una medida de rango: no se guarda.
      const guardar = r.tipo === "juego" && r.mejor != null;
      const texto = msg.nombre === "serie_completa" ? "¡Serie completa!" : "Detenido.";
      if (msg.nombre === "serie_completa") celebrar("¡SERIE COMPLETA!", "serie");
      if (!guardar) {
        estado.jugarTrasCalibrar = false;
        estado.pasoGuia = null;
        mostrarGuia(estado.plan && !estado.plan.requiere_calibracion ? "meta" : "normal");
        mostrarMensaje(`${texto} No había medidas para guardar.`);
        break;
      }
      const metaAnterior = r.meta;
      if (await guardarResumen(r)) {
        const nueva = estado.plan?.meta;
        const cambio = nueva == null || nueva === metaAnterior ? ""
          : ` Tu próxima meta: ${nueva}° (${(estado.plan.direccion === "arriba" ? nueva > metaAnterior : nueva < metaAnterior) ? "sube" : "baja"} según cómo te fue).`;
        mostrarMensaje(`${texto} ${r.validas} de ${r.intentadas} repeticiones válidas.${cambio}`, "ok");
      }
      break;
    }
  }
}

function registrarEvento(msg) {
  const li = document.createElement("li");
  const detalle = msg.motivo ? ` (${msg.motivo})` : msg.angulo_pico != null ? ` · pico ${msg.angulo_pico}°` : "";
  li.textContent = `${new Date(msg.t).toLocaleTimeString()} · ${msg.nombre}${detalle}`;
  $("eventos").prepend(li);
}

function conectar() {
  ws = new WebSocket(`ws://${location.host || "localhost:8765"}/ws`);
  const chip = $("conexion");
  ws.onopen = () => { chip.textContent = "Conectado"; chip.className = "chip ok"; };
  ws.onclose = () => {
    chip.textContent = "Sin conexión, reintentando…"; chip.className = "chip mal";
    setTimeout(conectar, 1500);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.tipo === "fotograma") {
      registrarAngulos(msg);
      // Se dibuja solo el último mensaje en cada repintado; los intermedios se descartan.
      const pendiente = ultimo !== null;
      ultimo = msg;
      if (!pendiente) {
        requestAnimationFrame(() => {
          dibujar(ultimo);
          escena.actualizarJugador(ultimo);
          actualizarPanel(ultimo);
          ultimo = null;
        });
      }
    } else if (msg.tipo === "evento") {
      manejarEvento(msg);
    }
  };
}

async function iniciar() {
  setInterval(() => { $("fase_guia").textContent = escena.faseGuia || "–"; }, 200);
  window.addEventListener("pagehide", cerrarSesion);
  try {
    const ejercicios = await api("GET", "/ejercicios");
    estado.ejercicios = Object.fromEntries(ejercicios.map((e) => [e.clave, e]));
    $("sel_ejercicio").replaceChildren(...ejercicios.map((e) => new Option(e.nombre, e.clave)));
    actualizarEjercicio();
    await cargarJugadores();
  } catch (e) {
    mostrarMensaje(`No se pudo cargar la API de datos: ${e.message}`, "mal");
  }
  conectar();
}

iniciar();
