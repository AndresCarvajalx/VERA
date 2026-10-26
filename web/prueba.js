// Página del prototipo: jugador, evaluación inicial de rango, juego con las reglas ROM,
// guardado de resultados en la base de datos y progreso. El video nunca llega al navegador:
// todo se dibuja con los puntos que envía el servicio de visión.
import { Escena3D } from "./escena3d.js";
import { dibujarProgreso } from "./progreso.js";

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
const estado = { ejercicios: {}, jugador: null, objetivos: [], progreso: [], sesionId: null, latenciaSuma: 0, latenciaN: 0 };

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
  const actividad = msg.evaluacion ?? msg.rep;
  actualizarVista(msg, actividad);
  $("aviso_compensacion").classList.toggle("oculto", !actividad?.compensacion);
  if (actividad?.compensacion) $("aviso_compensacion").textContent = actividad.compensacion;
  if (msg.evaluacion) {
    $("progreso_evaluacion").style.width = `${msg.evaluacion.progreso * 100}%`;
    const mejor = msg.evaluacion.mejor == null ? "–" : `${msg.evaluacion.mejor.toFixed(0)}°`;
    $("estado_evaluacion").textContent = msg.evaluacion.fase === "verificando_vista"
      ? "Esperando a verte de lado…" : `Midiendo… tu mejor ángulo hasta ahora: ${mejor}`;
  }
  actualizarReto(msg.rep);
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
  if (!rep) return;
  // La barra avanza hacia la meta: en "abajo" (estirar) avanza cuando el ángulo baja.
  const arriba = rep.direccion === "arriba";
  const escala = arriba ? rep.max_fisiologico : 100;
  const avance = (v) => (arriba ? v : escala - v);
  const pct = (v) => `${Math.max(0, Math.min(100, (avance(v) / escala) * 100))}%`;
  $("barra_amplitud").style.width = rep.angulo == null ? "0" : pct(rep.angulo);
  $("barra_amplitud").classList.toggle("en_objetivo", rep.estado === "en_objetivo" || rep.estado === "bajando");
  $("marca_objetivo").style.left = pct(rep.umbral_meta);
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

function mostrarMensaje(texto, tipo = "") {
  const m = $("mensaje");
  m.textContent = texto;
  m.className = `mensaje ${tipo}`;
}

// --- jugador, ejercicio y metas -----------------------------------------------
function seleccion() {
  const clave = $("sel_ejercicio").value;
  return { clave, regla: estado.ejercicios[clave], lado: $("sel_lado").value };
}

function objetivoVigente(clave, lado) {
  return estado.objetivos.find((o) => o.ejercicio === clave && o.lado === lado);
}

function ultimaEvaluacion(clave, lado) {
  const serie = estado.progreso.find((s) => s.ejercicio === clave && s.lado === lado);
  return serie?.puntos.filter((p) => p.tipo === "evaluacion").at(-1);
}

function actualizarEjercicio() {
  const { clave, regla, lado } = seleccion();
  if (!regla) return;
  $("descripcion_ejercicio").textContent = regla.descripcion;
  $("instruccion_camara").textContent =
    `Posición: ${POSICION[regla.posicion]}. Ponte de lado, con tu pierna ${LADOS[lado]} hacia la cámara.`;
  const objetivo = objetivoVigente(clave, lado);
  const form = $("form_juego");
  form.meta.value = objetivo?.meta ?? regla.meta_por_defecto;
  if (objetivo) {
    form.repeticiones.value = objetivo.repeticiones;
    form.tiempo_sostenido_ms.value = objetivo.tiempo_sostenido_ms;
    form.aprobado_por.value = objetivo.aprobado_por;
  }
  const limite = regla.direccion === "arriba" ? `máximo ${regla.max_fisiologico}°` : `mínimo ${regla.min_fisiologico}°`;
  $("nota_meta").textContent = (objetivo ? `Meta aprobada por ${objetivo.aprobado_por}. ` :
    `Meta por defecto de las reglas (${regla.meta_por_defecto}°): debe definirla el fisioterapeuta. `) +
    `Límite de referencia: ${limite}.` + (regla.direccion === "abajo" ? " Aquí la meta es un ángulo bajo: 0° = pierna recta." : "");
  mostrarGuia();
}

function mostrarGuia() {
  const { clave, regla, lado } = seleccion();
  if (!regla) return;
  const meta = Number($("form_juego").meta.value) || regla.meta_por_defecto;
  escena.mostrarEjercicio({
    ...GUIA[clave], lado,
    // La guía sentada parte de 90° de flexión y estira hasta la meta.
    objetivo: regla.direccion === "arriba" ? meta : Math.max(0, 90 - meta),
    tiempo_sostenido_ms: Math.max(800, Number($("form_juego").tiempo_sostenido_ms.value) || 0),
  });
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
  estado.jugador = codigo || null;
  estado.sesionId = null; // cada jugador tiene su propia sesión
  $("jugador_actual").textContent = codigo ? `Jugador ${codigo}` : "Sin jugador";
  $("jugador_actual").className = codigo ? "chip ok" : "chip";
  if (!codigo) {
    estado.objetivos = []; estado.progreso = [];
    pintarProgreso();
    return;
  }
  recordar("jugador", codigo);
  const datos = await api("GET", `/pacientes/${encodeURIComponent(codigo)}`);
  estado.objetivos = datos.objetivos;
  await cargarProgreso();
  actualizarEjercicio();
}

async function cargarProgreso() {
  if (!estado.jugador) return;
  estado.progreso = await api("GET", `/pacientes/${encodeURIComponent(estado.jugador)}/progreso`);
  pintarProgreso();
}

function pintarProgreso() {
  const vacio = !estado.jugador ? "Elige un jugador para ver su progreso."
    : !estado.progreso.length ? "Todavía no hay resultados guardados. Empieza con «Evaluar mi rango»." : "";
  $("progreso_vacio").textContent = vacio;
  $("progreso_vacio").classList.toggle("oculto", !vacio);
  dibujarProgreso($("tarjetas_progreso"), estado.progreso, $("tooltip"));
}

async function guardarResumen(resumen) {
  if (!estado.jugador) {
    mostrarMensaje("No hay jugador elegido: este resultado no se guardó.", "mal");
    return;
  }
  try {
    if (!estado.sesionId) {
      estado.sesionId = (await api("POST", "/sesiones", { paciente: estado.jugador })).id;
    }
    await api("POST", `/sesiones/${estado.sesionId}/resultados`, resumen);
    await cargarProgreso();
    return true;
  } catch (e) {
    mostrarMensaje(`No se pudo guardar: ${e.message}`, "mal");
    return false;
  }
}

function cerrarSesion() {
  if (!estado.sesionId) return;
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
$("form_juego").addEventListener("input", mostrarGuia);

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

$("btn_evaluar").addEventListener("click", () => {
  if (!requiereJugador()) return;
  const { clave, lado } = seleccion();
  mostrarMensaje("Evaluando tu rango: ponte de lado y haz el movimiento lo más que puedas, sin dolor.");
  $("estado_evaluacion").textContent = "Esperando a verte de lado…";
  enviar("evaluar_rango", { ejercicio: clave, lado, duracion_ms: 15000 });
});

$("form_juego").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!requiereJugador()) return;
  const { clave, lado } = seleccion();
  const f = e.target;
  const datos = {
    ejercicio: clave, lado, meta: Number(f.meta.value), repeticiones: Number(f.repeticiones.value),
    tiempo_sostenido_ms: Number(f.tiempo_sostenido_ms.value),
  };
  const aprobado = f.aprobado_por.value.trim();
  if (aprobado) {
    try {
      const objetivo = await api("PUT", `/pacientes/${encodeURIComponent(estado.jugador)}/objetivos`, { ...datos, aprobado_por: aprobado });
      estado.objetivos = [...estado.objetivos.filter((o) => !(o.ejercicio === clave && o.lado === lado)), objetivo];
    } catch (err) {
      mostrarMensaje(err.message, "mal");
      return;
    }
  }
  const evaluacion = ultimaEvaluacion(clave, lado);
  mostrarGuia();
  enviar("iniciar_ejercicio", { ...datos, reposo: evaluacion?.reposo ?? null });
});

for (const boton of document.querySelectorAll("[data-comando]")) {
  boton.addEventListener("click", () => enviar(boton.dataset.comando));
}

// --- eventos del servicio -----------------------------------------------------------
const MOTIVOS_REP = { no_llego: "no llegaste a la meta", no_sostuvo: "no sostuviste el tiempo", compensacion: "hubo compensación" };

async function manejarEvento(msg) {
  registrarEvento(msg);
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
      mostrarMensaje(`¡Repetición ${msg.numero} válida! Llegaste a ${msg.angulo_pico}°`, "ok");
      break;
    case "rep_incompleta":
      mostrarMensaje(`Repetición incompleta (${MOTIVOS_REP[msg.motivo] ?? msg.motivo}): llegaste a ${msg.angulo_pico}°. ¡Sigue!`);
      break;
    case "evaluacion_fallida":
      $("progreso_evaluacion").style.width = "0";
      $("estado_evaluacion").textContent = "";
      mostrarMensaje("No pude medir tu rango: no se vio bien la pierna. Revisa la luz y el encuadre e inténtalo otra vez.", "mal");
      break;
    case "evaluacion_lista": {
      const r = msg.resumen;
      $("progreso_evaluacion").style.width = "0";
      $("estado_evaluacion").textContent = `Tu rango: de ${r.reposo}° a ${r.mejor}°.`;
      if (await guardarResumen(r)) mostrarMensaje(`Rango medido y guardado: llegaste a ${r.mejor}°.`, "ok");
      break;
    }
    case "serie_completa":
    case "ejercicio_detenido": {
      const r = msg.resumen;
      const guardar = r.tipo === "juego" || r.completo; // una evaluación interrumpida no es una línea base
      const texto = msg.nombre === "serie_completa" ? "¡Serie completa!" : "Ejercicio detenido.";
      if (guardar && r.mejor != null) {
        if (await guardarResumen(r)) mostrarMensaje(`${texto} Resultado guardado: mejor ${r.mejor}°.`, "ok");
      } else {
        mostrarMensaje(`${texto} No había medidas para guardar.`);
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
