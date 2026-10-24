// Página de prueba del Paso 1: dibuja el esqueleto con los landmarks recibidos
// (el video nunca llega al navegador) y muestra ángulos, FPS y latencia.

const CONEXIONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],          // tronco
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], // pierna izquierda
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32], // pierna derecha
  [11, 13], [13, 15], [12, 14], [14, 16],          // brazos
];
const MIEMBRO_INFERIOR = new Set([23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
const UMBRAL_VISIBILIDAD = 0.5;

const lienzo = document.getElementById("lienzo");
const ctx = lienzo.getContext("2d");
const $ = (id) => document.getElementById(id);
const latencias = [];

function color(nombre) {
  return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
}

function dibujar(msg) {
  const [ancho, alto] = msg.imagen;
  if (lienzo.width !== ancho) { lienzo.width = ancho; lienzo.height = alto; }
  ctx.clearRect(0, 0, ancho, alto);
  if (!msg.landmarks.length) return;
  // Espejo horizontal: el jugador se ve como en un espejo.
  const p = (i) => [(1 - msg.landmarks[i][0]) * ancho, msg.landmarks[i][1] * alto];
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
  // Rótulo del ángulo de rodilla junto a cada rodilla.
  ctx.font = "bold 16px system-ui";
  ctx.fillStyle = color("--texto");
  for (const [lado, i] of [["izq", 25], ["der", 26]]) {
    const v = msg.angulos[`rodilla_${lado}`];
    if (v != null) ctx.fillText(`${Math.round(v)}°`, p(i)[0] + 10, p(i)[1]);
  }
}

const NOMBRES = { hombro: "hombro", cadera: "cadera", rodilla: "rodilla", tobillo: "tobillo", talon: "talón", pie: "pie" };

// "pie_der" → "pie derecho"; si faltan ambos lados se agrupan: "pies".
function textoAviso(msg) {
  if (!msg.persona) return "No te veo: ubícate de cuerpo completo frente a la cámara";
  const partes = {};
  for (const clave of msg.faltan) {
    const [parte, lado] = clave.split("_");
    (partes[parte] ??= []).push(lado === "der" ? "derecho" : "izquierdo");
  }
  const frases = Object.entries(partes).map(([parte, lados]) => {
    const nombre = NOMBRES[parte];
    if (lados.length === 2) return parte === "talon" ? "talones" : nombre === "pie" ? "pies" : `${nombre}s`;
    return `${nombre} ${lados[0]}`;
  });
  return `No se ve: ${frases.join(", ")}`;
}

function actualizarPanel(msg) {
  const latencia = Date.now() - msg.t_captura; // t_render − t_captura (mismo reloj del equipo)
  latencias.push(latencia);
  if (latencias.length > 30) latencias.shift();
  const promedio = latencias.reduce((a, b) => a + b, 0) / latencias.length;
  $("fps").textContent = msg.fps.toFixed(1);
  // Meta del OE4: 15 FPS. Con poca luz la cámara alarga la exposición y entrega menos fotogramas.
  const lento = msg.fps > 0 && msg.fps < 15;
  $("fps").style.color = lento ? color("--mal") : "";
  $("aviso_fps").classList.toggle("oculto", !lento);
  $("latencia").textContent = `${Math.round(promedio)} ms`;
  $("encuadre").textContent = msg.encuadre_ok ? "OK" : "No";
  $("encuadre").style.color = msg.encuadre_ok ? color("--ok") : color("--mal");
  $("aviso").classList.toggle("oculto", msg.encuadre_ok);
  if (!msg.encuadre_ok) $("aviso").textContent = textoAviso(msg);
  // Con calibración se muestra cuánto se cerró cada articulación desde la neutra.
  const angulos = msg.angulos_rel ?? msg.angulos;
  for (const [clave, valor] of Object.entries(angulos)) {
    const celda = $(clave);
    if (!celda) continue;
    if (valor == null) celda.textContent = "–";
    else celda.textContent = msg.angulos_rel ? `${valor > 0 ? "+" : ""}${valor.toFixed(1)}°` : `${valor.toFixed(1)}°`;
  }
  $("progreso_calibracion").style.width = msg.calibracion ? `${msg.calibracion.progreso * 100}%` : "0";
  actualizarReto(msg.rep);
}

const ESTADOS = {
  reposo: "En reposo", subiendo: "Vas bien…", en_objetivo: "¡Sostén!", bajando: "Vuelve despacio",
  pausado: "En pausa", no_visible: "No veo esa pierna",
};

const MOTIVOS = {
  movimiento: "Te moviste durante la calibración. Quédate quieto y vuelve a calibrar.",
  sin_datos: "No se vio la pierna durante la calibración. Revisa el encuadre.",
};

function mostrarMensaje(texto, tipo = "") {
  const m = $("mensaje");
  m.textContent = texto;
  m.className = `mensaje ${tipo}`;
}

function actualizarReto(rep) {
  $("reto").classList.toggle("oculto", !rep);
  if (!rep) return;
  const escala = rep.objetivo * 1.5; // la barra llega a 150 % del objetivo
  const pct = (v) => `${Math.max(0, Math.min(100, (v / escala) * 100))}%`;
  $("barra_amplitud").style.width = rep.amplitud == null ? "0" : pct(rep.amplitud);
  $("barra_amplitud").classList.toggle("en_objetivo", rep.estado === "en_objetivo" || rep.estado === "bajando");
  $("marca_objetivo").style.left = pct(rep.objetivo - rep.tolerancia);
  let estado = ESTADOS[rep.estado] ?? rep.estado;
  if (rep.estado === "en_objetivo") estado += ` ${(rep.sostenido_ms / 1000).toFixed(1)} / ${(rep.tiempo_sostenido_ms / 1000).toFixed(1)} s`;
  const amplitud = rep.amplitud == null ? "–" : `${rep.amplitud.toFixed(0)}°`;
  $("reto_estado").textContent = `${estado} · ${amplitud}`;
  $("reto_reps").textContent = `${rep.validas} / ${rep.meta}`;
  $("reto_maximo").textContent = rep.amplitud_max == null
    ? "Máximo alcanzado: –"
    : `Máximo alcanzado: ${rep.amplitud_max.toFixed(0)}° (meta ${rep.objetivo - rep.tolerancia}°)`;
}

let ws = null;
let ultimo = null;

function enviar(nombre, datos = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ tipo: "comando", nombre, ...datos }));
}

$("btn_calibrar").addEventListener("click", () => {
  mostrarMensaje("Calibrando: quédate quieto…");
  enviar("calibrar");
});
$("form_ejercicio").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("resumen").classList.add("oculto");
  enviar("iniciar_ejercicio", {
    articulacion: f.get("articulacion"),
    lado: f.get("lado"),
    sentido: Number(f.get("sentido")),
    objetivo: Number(f.get("objetivo")),
    tolerancia: Number(f.get("tolerancia")),
    tiempo_sostenido_ms: Number(f.get("tiempo_sostenido_ms")),
    repeticiones: Number(f.get("repeticiones")),
  });
});
for (const boton of document.querySelectorAll("[data-comando]")) {
  boton.addEventListener("click", () => enviar(boton.dataset.comando));
}

function manejarEvento(msg) {
  registrarEvento(msg);
  if (msg.nombre === "calibracion_lista") {
    const neutros = Object.entries(msg.neutros).map(([k, v]) => `${k.replace("_", " ")} ${v}°`).join(", ");
    $("nota_angulos").textContent = `Grados desde tu posición neutra (+ = se dobla). Neutra: ${neutros}`;
    mostrarMensaje("Calibración lista. Ya puedes iniciar el ejercicio.", "ok");
  } else if (msg.nombre === "calibracion_fallida") {
    mostrarMensaje(MOTIVOS[msg.motivo] ?? `Calibración fallida: ${msg.motivo}`, "mal");
  } else if (msg.nombre === "comando_rechazado") {
    mostrarMensaje(`No se pudo: ${msg.motivo}`, "mal");
  } else if (msg.nombre === "rep_valida") {
    mostrarMensaje(`¡Repetición ${msg.numero} válida! Llegaste a ${msg.angulo_pico}°`, "ok");
  } else if (msg.nombre === "rep_incompleta") {
    mostrarMensaje(`Repetición incompleta: llegaste a ${msg.angulo_pico}°. ¡Sigue intentando!`);
  } else if (msg.nombre === "serie_completa" || msg.nombre === "ejercicio_detenido") {
    mostrarMensaje(msg.nombre === "serie_completa" ? "¡Serie completa!" : "Ejercicio detenido.", "ok");
    $("resumen").textContent = JSON.stringify(msg.resumen, null, 2);
    $("resumen").classList.remove("oculto");
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
      // Se dibuja solo el último mensaje en cada repintado; si llegan varios entre dos, los viejos se descartan.
      const pendiente = ultimo !== null;
      ultimo = msg;
      if (!pendiente) requestAnimationFrame(() => { dibujar(ultimo); actualizarPanel(ultimo); ultimo = null; });
    } else if (msg.tipo === "evento") {
      manejarEvento(msg);
    }
  };
}

conectar();
