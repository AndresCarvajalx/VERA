// Página del prototipo: jugador, evaluación inicial de rango, juego con las reglas ROM,
// guardado de resultados en la base de datos y progreso. El video nunca llega al navegador:
// todo se dibuja con los puntos que envía el servicio de visión.
import { Ajustes } from "./ajustes.js";
import { Escena3D } from "./escena3d.js";
import { Encuesta } from "./encuesta.js";
import { Estrellas } from "./estrellas.js";
import { CELEBRACION, Flujo } from "./flujo.js";
import { poseQuieta, poseSaludo } from "./guia.js";
import { imprimirInformeTecnico } from "./informe.js";
import { Logros } from "./logros.js";
import { Manual } from "./manual.js";
import { Mascotas } from "./mascotas.js";
import { MiProgreso } from "./mi_progreso.js";
import { dibujarProgreso } from "./progreso.js";
import { sonido } from "./sonido.js";
import { iniciarTema, temaActual } from "./tema.js";
import { etapaPorAvance } from "./toribara.js";
import { mostrarTutorial } from "./tutorial.js";
import { Vitrina } from "./vitrina.js";
import { voz } from "./voz.js";

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
// Con dos páginas abiertas las dos reciben los resultados: guarda solo la que pidió la actividad.
const ID_PAGINA = Math.random().toString(36).slice(2);
const latencias = [];
const estado = {
  ejercicios: {}, jugador: null, progreso: [], plan: null, sesionId: null, pasoGuia: null, finActividad: 0,
  jugarTrasCalibrar: false, latenciaSuma: 0, latenciaN: 0, muestrasLatencia: [], fpsSuma: 0, fpsN: 0,
};

// Color de una variable del tema, ya resuelto (p. ej. un par light-dark() según dónde se use).
// `donde`: el lienzo que lo va a usar; puede estar en una zona siempre oscura aunque la página sea clara.
const coloresResueltos = new Map();
function color(nombre, donde = document.body) {
  let porNombre = coloresResueltos.get(donde);
  if (!porNombre) coloresResueltos.set(donde, porNombre = { sonda: donde.appendChild(document.createElement("span")) });
  if (!porNombre[nombre]) {
    porNombre.sonda.hidden = true;
    porNombre.sonda.style.color = `var(${nombre})`;
    porNombre[nombre] = getComputedStyle(porNombre.sonda).color;
  }
  return porNombre[nombre];
}
function olvidarColores() {
  for (const porNombre of coloresResueltos.values()) for (const n of Object.keys(porNombre)) if (n !== "sonda") delete porNombre[n];
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", olvidarColores);

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
function dibujar(msg, lienzo = $("lienzo")) {
  const ctx = lienzo.getContext("2d");
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
    ctx.strokeStyle = MIEMBRO_INFERIOR.has(a) && MIEMBRO_INFERIOR.has(b) ? color("--acento", lienzo) : color("--suave", lienzo);
    ctx.beginPath(); ctx.moveTo(...p(a)); ctx.lineTo(...p(b)); ctx.stroke();
  }
  for (let i = 11; i < msg.landmarks.length; i++) {
    ctx.fillStyle = visible(i) ? color("--texto", lienzo) : color("--mal", lienzo);
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

/** Latencia (t_render − t_captura, mismo reloj del equipo) y FPS de cada fotograma dibujado. */
function medirRendimiento(msg) {
  const latencia = Date.now() - msg.t_captura;
  latencias.push(latencia);
  if (latencias.length > 30) latencias.shift();
  estado.latenciaSuma += latencia; estado.latenciaN += 1;
  if (estado.muestrasLatencia.length < 20000) estado.muestrasLatencia.push(latencia);
  if (msg.fps > 0) { estado.fpsSuma += msg.fps; estado.fpsN += 1; }
}

function rendimientoDeSesion() {
  const m = [...estado.muestrasLatencia].sort((a, b) => a - b);
  return {
    latencia_promedio_ms: estado.latenciaN ? Math.round((estado.latenciaSuma / estado.latenciaN) * 10) / 10 : null,
    latencia_p95_ms: m.length ? m[Math.min(m.length - 1, Math.floor(m.length * 0.95))] : null,
    fps_promedio: estado.fpsN ? Math.round((estado.fpsSuma / estado.fpsN) * 10) / 10 : null,
  };
}

function actualizarPanel(msg) {
  const lectura = lecturaEstable(`${$("ref_articulacion").value}_${$("ref_lado").value}`);
  $("ref_sistema").textContent = !lectura ? "– (no se ve la articulación)"
    : `${lectura.mediana.toFixed(1)}° ${lectura.desviacion <= 3 ? "· estable" : `· se mueve (±${lectura.desviacion.toFixed(1)}°)`}`;
  $("fps").textContent = msg.fps.toFixed(1);
  const lento = msg.fps > 0 && msg.fps < 15; // meta del OE4
  $("fps").style.color = lento ? "var(--mal)" : "";
  $("aviso_fps").classList.toggle("oculto", !lento);
  $("latencia").textContent = `${Math.round(latencias.reduce((a, b) => a + b, 0) / latencias.length)} ms`;
  $("encuadre").textContent = msg.encuadre_ok ? "OK" : "No";
  $("encuadre").style.color = msg.encuadre_ok ? "var(--ok)" : "var(--mal)";
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
    : msg.vista.lado_camara !== actividad.lado ? `Gírate: la cámara debe ver tu pierna ${pierna}`
      : seleccion().regla?.posicion === "sentado" && !msg.vista.muslo_horizontal ? "Siéntate con el muslo horizontal"
        : "¡Así! Quédate de perfil…";
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
  const m = pantallaActual === "personaje" ? $("mensaje_seleccion") : $("mensaje");
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
  $("progreso_jugador").replaceChildren(new Option("— elige —", ""), ...codigos.map((c) => new Option(c, c)));
  const elegido = seleccionar ?? recuperar("jugador");
  if (elegido && codigos.includes(elegido)) {
    sel.value = elegido;
    await elegirJugador(elegido);
  }
}

async function elegirJugador(codigo) {
  cerrarSesion();
  estado.jugador = codigo || null;
  $("sel_jugador").value = codigo || "";
  estado.sesionId = null; // cada jugador tiene su propia sesión (y debe calibrar en ella)
  Object.assign(estado, { latenciaSuma: 0, latenciaN: 0, muestrasLatencia: [], fpsSuma: 0, fpsN: 0 });
  $("jugador_actual").textContent = codigo ? `Jugador ${codigo}` : "Sin jugador";
  $("jugador_actual").className = codigo ? "chip ok" : "chip";
  if (codigo) recordar("jugador", codigo);
  if (codigo) {
    const datos = await api("GET", `/pacientes/${encodeURIComponent(codigo)}`);
    marcarPersonaje(datos.personaje);
  }
  estado.progreso = codigo ? await api("GET", `/pacientes/${encodeURIComponent(codigo)}/progreso`) : [];
  pintarProgreso();
  actualizarEjercicio();
  cargarPrecision().catch(() => {});
  pintarEscenarios();
}

// --- escenarios desbloqueables -----------------------------------------------------------
// Se ganan con los días jugados (no hace falta que sean seguidos): así nadie pierde lo ganado.
const ESCENARIOS = [
  { clave: "ciudad", nombre: "Ciudad de neón", dias: 0 },
  { clave: "playa", nombre: "Playa al atardecer", dias: 3 },
  { clave: "espacio", nombre: "Espacio", dias: 7 },
];

async function pintarEscenarios() {
  let dias = 0;
  if (estado.jugador) {
    try { dias = (await logros.cargar(estado.jugador)).dias_jugados; } catch { /* sin datos: solo la ciudad */ }
  }
  const guardado = estado.jugador ? recuperar(`escenario_${estado.jugador}`) : null;
  const elegido = ESCENARIOS.find((e) => e.clave === guardado && dias >= e.dias)?.clave ?? "ciudad";
  escena.cambiarAmbiente(elegido);
  $("selector_escenario").replaceChildren(...ESCENARIOS.map((e) => {
    const libre = dias >= e.dias;
    const b = Object.assign(document.createElement("button"), { type: "button", className: `escenario escenario-${e.clave}` });
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(e.clave === elegido));
    b.disabled = !libre;
    b.append(Object.assign(document.createElement("span"), { className: "muestra-escenario", ariaHidden: "true" }),
      Object.assign(document.createElement("strong"), { textContent: e.nombre }),
      Object.assign(document.createElement("small"), {
        textContent: libre ? (e.dias ? `Desbloqueado: ${e.dias} días jugados` : "Disponible desde el inicio")
          : `Juega ${e.dias} días para desbloquearlo (llevas ${dias})`,
      }));
    if (!libre) {
      const candado = Object.assign(document.createElement("span"), { className: "icono" });
      candado.dataset.icono = "candado";
      candado.setAttribute("aria-hidden", "true");
      b.prepend(candado);
    }
    b.addEventListener("click", () => {
      if (estado.jugador) recordar(`escenario_${estado.jugador}`, e.clave);
      pintarEscenarios();
    });
    return b;
  }));
}

// --- personaje elegible --------------------------------------------------------
const PERSONAJE_POR_DEFECTO = "persona"; // el mismo que la API (rutas.PERSONAJE_POR_DEFECTO)

// Una vista 3D por personaje, en fila: respiran quietos girando un poco, y el elegido saluda.
const vitrinas = new Map(); // clave → Vitrina
let personajeElegido = null;

function pintarSelectorPersonajes(personajes) {
  $("selector_personaje").replaceChildren(...personajes.map((p, i) => {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "personaje";
    boton.setAttribute("role", "radio");
    boton.dataset.personaje = p.clave;
    const vista = Object.assign(document.createElement("div"), { className: "vista-personaje" });
    boton.append(vista, Object.assign(document.createElement("strong"), { textContent: p.nombre }),
      Object.assign(document.createElement("span"), { textContent: p.descripcion }));
    boton.addEventListener("click", () => elegirPersonaje(p.clave));
    const desfase = i * 1700; // que no se muevan todos al mismo tiempo
    const vitrina = new Vitrina(vista, {
      pose: (t) => ({
        pts: personajeElegido === p.clave ? poseSaludo(t, 1) : poseQuieta(t + desfase),
        giro: Math.sin((t + desfase) / 2200) * 0.5,
      }),
    });
    vitrina.poner(p.clave);
    vitrinas.set(p.clave, vitrina);
    return boton;
  }));
}

/** Muestra el personaje elegido en el selector y en la escena (jugador y guía). */
function marcarPersonaje(clave) {
  personajeElegido = clave;
  for (const b of $("selector_personaje").querySelectorAll(".personaje")) {
    b.setAttribute("aria-checked", String(b.dataset.personaje === clave));
  }
  for (const [c, v] of vitrinas) v.colorAro(c === clave ? "--lima" : "--cian");
  escena.cambiarPersonaje(clave);
}

async function elegirPersonaje(clave) {
  marcarPersonaje(clave);
  // Se guarda con el jugador, para que lo encuentre igual la próxima vez y en otro equipo.
  if (!estado.jugador) { recordar("personaje", clave); return; }
  try {
    await api("PATCH", `/pacientes/${encodeURIComponent(estado.jugador)}`, { personaje: clave });
    const nombre = $("selector_personaje").querySelector(`[data-personaje="${clave}"] strong`).textContent;
    mostrarMensaje(`¡Ahora juegas con ${nombre}!`, "ok");
  } catch (e) {
    mostrarMensaje(`No se pudo guardar el personaje: ${e.message}`, "mal");
  }
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
  if (resumen.cliente !== ID_PAGINA) return false;
  if (!estado.jugador) {
    mostrarMensaje("No hay jugador elegido: este resultado no se guardó.", "mal");
    return;
  }
  try {
    await asegurarSesion();
    await api("POST", `/sesiones/${estado.sesionId}/resultados`, resumen);
    api("PATCH", `/sesiones/${estado.sesionId}`, { ...rendimientoDeSesion(), terminar: false }).catch(() => {});
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
  fetch(`/api/sesiones/${estado.sesionId}`, {
    method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rendimientoDeSesion()),
  });
}

// --- comandos ---------------------------------------------------------------------
let ws = null;
let ultimo = null;

function enviar(nombre, datos = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: "comando", nombre, cliente: ID_PAGINA, ...datos }));
  else mostrarMensaje("Sin conexión con el servicio de visión.", "mal");
}

function requiereJugador() {
  if (estado.jugador) return true;
  mostrarMensaje("Primero elige o crea un jugador: así se guarda su progreso.", "mal");
  return false;
}

const escena = new Escena3D($("escena3d"));
const estrellas = new Estrellas($("estrellas"));
const mascotas = new Mascotas($("mascotas"), $("globo"), ["persona", "mujer", "toribara", "conejibara"]);
const ajustes = new Ajustes(api, dibujar);
const miProgreso = new MiProgreso(api, elegirJugador, $("tooltip"));
let manual = null; // se crea cuando llega el catálogo de ejercicios

// --- pantallas -------------------------------------------------------------------
// Solo la pantalla visible dibuja en 3D: cada una tiene su propio lienzo WebGL.
let pantallaActual = "menu";

const logros = new Logros(api);
const encuesta = new Encuesta(api);
const flujo = new Flujo({
  enviar, dibujar, textoAviso, recordar, recuperar, mostrarGuia, guardarResumen, cargarPlan, logros, encuesta,
  demostrar: (ejercicio) => escena.mostrarEjercicio(ejercicio),
  // La primera vez de cada jugador (en este navegador) se muestra el tutorial antes de empezar.
  tutorial: async (jugador) => {
    if (recuperar(`tutorial_${jugador}`)) return;
    await mostrarTutorial();
    recordar(`tutorial_${jugador}`, "1");
  },
  ejercicios: () => estado.ejercicios,
  progreso: () => estado.progreso,
  elegirEjercicio: (clave, lado) => {
    $("sel_ejercicio").value = clave;
    $("sel_lado").value = lado;
    actualizarEjercicio();
  },
  irA: (pantalla) => mostrarPantalla(pantalla),
});

// --- sonido --------------------------------------------------------------------------
function pintarSonido() {
  const b = $("btn_sonido");
  b.setAttribute("aria-pressed", String(sonido.silencio));
  b.setAttribute("aria-label", sonido.silencio ? "Activar el sonido" : "Silenciar");
  b.title = b.getAttribute("aria-label");
}
$("btn_sonido").addEventListener("click", () => {
  sonido.fijarSilencio(!sonido.silencio);
  if (sonido.silencio) voz.callar();
  pintarSonido();
});
for (const [id, tipo] of [["vol_musica", "musica"], ["vol_efectos", "efectos"]]) {
  $(id).value = Math.round(sonido.volumen[tipo] * 100);
  $(id).addEventListener("input", (e) => sonido.fijarVolumen(tipo, e.target.value / 100));
}
$("vol_efectos").addEventListener("change", () => sonido.efecto("bien"));
$("probar_sonidos").addEventListener("click", (e) => {
  const efecto = e.target.dataset?.efecto;
  if (efecto) sonido.efecto(efecto);
});
pintarSonido();
$("voz_activa").checked = voz.activa;
$("voz_activa").disabled = !voz.disponible;
$("voz_activa").addEventListener("change", (e) => voz.fijar(e.target.checked));
$("btn_ver_tutorial").addEventListener("click", () => mostrarTutorial());
$("btn_informe_tecnico").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try { imprimirInformeTecnico(await api("GET", "/indicadores")); }
  catch (error) { mostrarMensaje(`No se pudo armar el informe: ${error.message}`, "mal"); }
  finally { e.target.disabled = false; }
});
$("probar_voz").addEventListener("click", () => voz.decir("¡Hola! Así te voy a guiar durante la sesión.", { forzar: true }));
$("voz_nombre").addEventListener("change", (e) => {
  voz.elegir(e.target.value || null);
  voz.decir("Esta es la voz que te va a guiar.", { forzar: true });
});
// Lista de voces en español: llega tarde (sobre todo las de la nube) y cambia según el navegador.
voz.alCambiar(() => {
  const hay = voz.voces.length > 0;
  $("voz_nombre").replaceChildren(new Option("Automática (la de mejor calidad)", ""),
    ...voz.voces.map((v) => new Option(`${v.name} · ${v.lang}`, v.name)));
  $("voz_nombre").value = recuperar("voz_nombre") ?? "";
  $("voz_nombre").disabled = !hay;
  $("probar_voz").disabled = !hay;
  $("voz_activa").disabled = !hay;
  $("voz_nota").textContent = !voz.disponible ? "Este navegador no puede leer en voz alta."
    : hay ? (/natural|online|google/i.test(voz.nombre) ? "" : "Para una voz más natural, abre VERA en Microsoft Edge: trae voces en español de mejor calidad.")
      : "Este equipo no tiene ninguna voz en español, así que la voz está apagada. Abre VERA en Microsoft Edge (trae voces en español) o instala una en Windows: Configuración → Hora e idioma → Voz → Agregar voces → Español.";
});

/** Estrellas y mascotas: solo en el tema actual; el profesional no lleva adornos. */
function adornar() {
  const sobrio = temaActual() === "profesional";
  const enEjercicio = pantallaActual === "sesion" || pantallaActual === "juego";
  estrellas.modo(sobrio || enEjercicio ? "quieto" : pantallaActual === "menu" ? "menu" : "calmo");
  mascotas.activar(pantallaActual === "menu" && !sobrio);
}
document.addEventListener("tema", () => { olvidarColores(); adornar(); escena.cambiarTema(temaActual() === "profesional"); });
iniciarTema();
if (temaActual() === "profesional") escena.cambiarTema(true);

function mostrarPantalla(nombre) {
  // La sesión guiada y el panel necesitan jugador (ahí se guarda todo).
  if ((nombre === "sesion" || nombre === "juego") && !estado.jugador) nombre = "personaje";
  if (pantallaActual === "sesion" && nombre !== "sesion") flujo.salir();
  pantallaActual = nombre;
  sonido.musica(nombre === "sesion" || nombre === "juego" ? "ejercicio" : "menu");
  adornar();
  for (const p of document.querySelectorAll(".pantalla")) p.classList.toggle("activa", p.id === `pantalla_${nombre}`);
  for (const v of vitrinas.values()) v.activar(nombre === "personaje");
  // Una sola escena 3D: se muestra en la sesión guiada o en el panel del fisioterapeuta.
  if (nombre === "sesion") escena.moverA($("escena_sesion"));
  if (nombre === "juego") escena.moverA($("escena3d"));
  escena.camaraAmplia(nombre === "sesion");
  escena.activar(nombre === "juego" || nombre === "sesion");
  if (nombre === "sesion") flujo.entrar(estado.jugador);
  if (nombre === "manual") manual?.mostrar(personajeElegido ?? PERSONAJE_POR_DEFECTO);
  else manual?.ocultar();
  if (nombre === "ajustes") ajustes.mostrar();
  if (nombre === "progreso") miProgreso.mostrar(estado.jugador);
  if (nombre !== "sesion") voz.callar();
  window.scrollTo(0, 0);
}

for (const boton of document.querySelectorAll("[data-ir]")) {
  boton.addEventListener("click", () => mostrarPantalla(boton.dataset.ir));
}
$("btn_comenzar").addEventListener("click", () => {
  if (!requiereJugador()) return;
  flujo.reiniciar();
  mostrarPantalla("sesion");
});

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
  // Una calibración fallida o interrumpida no mide el rango, pero su tiempo sí cuenta como jugado.
  if (msg.resumen?.tipo === "calibracion" && !msg.resumen.completo && msg.resumen.duracion_s > 0) guardarResumen(msg.resumen);
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
    case "rep_valida":
      celebrar(...CELEBRACION[msg.calidad]);
      mostrarMensaje(`¡Repetición ${msg.numero} válida! Llegaste a ${msg.angulo_pico}°`, "ok");
      break;
    case "rep_incompleta":
      celebrar(...CELEBRACION[msg.calidad]);
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
          if (pantallaActual === "juego") {
            dibujar(ultimo);
            escena.actualizarJugador(ultimo);
            medirRendimiento(ultimo);
            actualizarPanel(ultimo);
          } else if (pantallaActual === "sesion") {
            escena.actualizarJugador(ultimo);
            medirRendimiento(ultimo);
            flujo.fotograma(ultimo);
          } else if (pantallaActual === "ajustes") {
            ajustes.fotograma(ultimo);
          }
          ultimo = null;
        });
      }
    } else if (msg.tipo === "evento") {
      sonido.evento(msg);
      if (msg.calidad) escena.celebrar(msg.calidad);
      else if (msg.nombre === "serie_completa") escena.celebrar("serie");
      if (pantallaActual === "sesion") {
        registrarEvento(msg);
        if (FIN_DE_ACTIVIDAD.has(msg.nombre)) estado.finActividad = msg.t;
        flujo.evento(msg);
      } else {
        manejarEvento(msg);
      }
    }
  };
}

/** Quita la pantalla de carga cuando el personaje del juego está listo (o a los 8 s, pase lo que pase). */
function terminarCarga() {
  const listo = Promise.allSettled([escena.listo, document.fonts.ready]);
  Promise.race([listo, new Promise((r) => setTimeout(r, 8000))]).then(() => {
    $("carga").classList.add("oculta");
    setTimeout(() => $("carga").remove(), 700);
  });
}

async function iniciar() {
  terminarCarga();
  mostrarPantalla("menu");
  mascotas.cargar().catch((e) => console.warn("No se pudieron cargar las mascotas del menú", e));
  setInterval(() => { $("fase_guia").textContent = escena.faseGuia || "–"; }, 200);
  window.addEventListener("pagehide", cerrarSesion);
  try {
    const ejercicios = await api("GET", "/ejercicios");
    estado.ejercicios = Object.fromEntries(ejercicios.map((e) => [e.clave, e]));
    $("sel_ejercicio").replaceChildren(...ejercicios.map((e) => new Option(e.nombre, e.clave)));
    manual = new Manual({ ejercicios, guias: GUIA, rangoNormal });
    manual.cargarRangos(api).catch((e) => { $("fuente_rangos").textContent = `No se pudo cargar la tabla: ${e.message}`; });
    pintarSelectorPersonajes(await api("GET", "/personajes"));
    marcarPersonaje(recuperar("personaje") ?? PERSONAJE_POR_DEFECTO); // hasta que se elija jugador
    actualizarEjercicio();
    await cargarJugadores();
    pintarEscenarios();
  } catch (e) {
    mostrarMensaje(`No se pudo cargar la API de datos: ${e.message}`, "mal");
  }
  conectar();
}

iniciar();
