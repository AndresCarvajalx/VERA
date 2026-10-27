// "Mi progreso": una tarjeta por ejercicio y pierna con el avance desde la primera calibración,
// una gráfica de línea (una sola serie: el rango calibrado en cada sesión), las referencias
// rotuladas (última meta del juego y rango normal), tooltip al pasar el mouse y la tabla de datos.

const LADOS = { der: "pierna derecha", izq: "pierna izquierda" };
const ANCHO = 320, ALTO = 170;
const M = { izq: 34, der: 56, arriba: 10, abajo: 24 }; // márgenes; a la derecha van los rótulos

const fmt = (v) => `${Math.round(v * 10) / 10}°`;
const fecha = (iso) => new Date(iso).toLocaleDateString("es-CO", { day: "numeric", month: "short" });
const hora = (iso) => new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function svg(etiqueta, atributos = {}, hijos = []) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", etiqueta);
  for (const [k, v] of Object.entries(atributos)) el.setAttribute(k, v);
  for (const h of hijos) el.append(h);
  return el;
}

function marcas(min, max, cantidad = 4) {
  const paso = [5, 10, 15, 20, 30, 45, 60].find((p) => (max - min) / p <= cantidad) ?? 90;
  const salida = [];
  for (let v = Math.ceil(min / paso) * paso; v <= max; v += paso) salida.push(v);
  return salida;
}

/** Gráfica de una serie. En ejercicios "abajo" (estirar) el eje va invertido: arriba = más recta. */
function grafica(serie, tooltip) {
  const valores = serie.puntos.map((p) => p.mejor);
  const arriba = serie.direccion === "arriba";
  const refs = [{ valor: serie.referencia, texto: `normal ${fmt(serie.referencia)}` }];
  if (serie.meta != null) refs.unshift({ valor: serie.meta, texto: `meta ${fmt(serie.meta)}` });
  let lo = Math.min(...valores, ...refs.map((r) => r.valor), 0);
  let hi = Math.max(...valores, ...refs.map((r) => r.valor));
  const holgura = Math.max(5, (hi - lo) * 0.08);
  lo -= holgura; hi += holgura;
  const ancho = ANCHO - M.izq - M.der, alto = ALTO - M.arriba - M.abajo;
  const n = serie.puntos.length;
  const x = (i) => M.izq + (n === 1 ? ancho / 2 : (i / (n - 1)) * ancho);
  const y = (v) => M.arriba + (arriba ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo)) * alto;

  const raiz = svg("svg", { viewBox: `0 0 ${ANCHO} ${ALTO}`, class: "grafica", role: "img",
    "aria-label": `${serie.nombre}: de ${fmt(valores[0])} a ${fmt(valores[n - 1])}` });
  for (const v of marcas(lo, hi)) {
    raiz.append(svg("line", { class: "rejilla", x1: M.izq, x2: ANCHO - M.der, y1: y(v), y2: y(v) }));
    const t = svg("text", { class: "eje", x: M.izq - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = `${v}°`;
    raiz.append(t);
  }
  // Referencias: línea punteada y rótulo directo a la derecha (sin leyenda aparte).
  const usados = [];
  for (const r of refs) {
    raiz.append(svg("line", { class: "referencia", x1: M.izq, x2: ANCHO - M.der, y1: y(r.valor), y2: y(r.valor) }));
    let ty = y(r.valor) + 4;
    while (usados.some((u) => Math.abs(u - ty) < 12)) ty += 12; // evita que los rótulos se encimen
    usados.push(ty);
    const t = svg("text", { class: "rotulo-ref", x: ANCHO - M.der + 4, y: ty });
    t.textContent = r.texto;
    raiz.append(t);
  }
  // Fechas en el eje x: primera y última, para no saturar.
  for (const i of n === 1 ? [0] : [0, n - 1]) {
    const t = svg("text", { class: "eje", x: x(i), y: ALTO - 6, "text-anchor": n === 1 ? "middle" : i === 0 ? "start" : "end" });
    t.textContent = fecha(serie.puntos[i].fecha);
    raiz.append(t);
  }
  if (n > 1) {
    raiz.append(svg("polyline", { class: "serie", points: serie.puntos.map((p, i) => `${x(i)},${y(p.mejor)}`).join(" ") }));
  }
  const guia = svg("line", { class: "guia-hover", y1: M.arriba, y2: ALTO - M.abajo, visibility: "hidden" });
  raiz.append(guia);
  serie.puntos.forEach((p, i) => {
    // Hueco = calibración poco consistente (los intentos variaron más de lo permitido).
    raiz.append(svg("circle", { class: `punto${p.consistente === false ? " inconsistente" : ""}`, cx: x(i), cy: y(p.mejor), r: 5 }));
  });
  // Zonas de hover más anchas que el punto: una franja vertical por resultado.
  serie.puntos.forEach((p, i) => {
    const izq = i === 0 ? M.izq : (x(i - 1) + x(i)) / 2;
    const der = i === n - 1 ? ANCHO - M.der : (x(i) + x(i + 1)) / 2;
    const zona = svg("rect", { class: "zona-hover", x: izq - (n === 1 ? ancho / 2 : 0), y: M.arriba,
      width: Math.max(8, der - izq + (n === 1 ? ancho : 0)), height: alto });
    zona.addEventListener("pointermove", (e) => {
      guia.setAttribute("x1", x(i)); guia.setAttribute("x2", x(i)); guia.setAttribute("visibility", "visible");
      tooltip.textContent = `${hora(p.fecha)} · rango calibrado ${fmt(p.reposo)}–${fmt(p.mejor)}` +
        (p.partidas ? ` · ${p.partidas} ${p.partidas === 1 ? "serie" : "series"}, ${p.validas}/${p.intentadas} repeticiones válidas` : " · sin series jugadas");
      tooltip.classList.remove("oculto");
      tooltip.style.left = `${e.clientX + 12}px`;
      tooltip.style.top = `${e.clientY + 12}px`;
    });
    zona.addEventListener("pointerleave", () => { guia.setAttribute("visibility", "hidden"); tooltip.classList.add("oculto"); });
    raiz.append(zona);
  });
  return raiz;
}

function tabla(serie) {
  const det = document.createElement("details");
  det.innerHTML = "<summary>Ver datos</summary>";
  const t = document.createElement("table");
  t.innerHTML = "<thead><tr><th>Fecha</th><th>Reposo</th><th>Rango</th><th>Series</th><th>Válidas</th></tr></thead>";
  const cuerpo = document.createElement("tbody");
  for (const p of serie.puntos) {
    const fila = document.createElement("tr");
    for (const texto of [hora(p.fecha), fmt(p.reposo), fmt(p.mejor) + (p.consistente === false ? " *" : ""),
      String(p.partidas), p.partidas ? `${p.validas}/${p.intentadas}` : "–"]) {
      const c = document.createElement("td");
      c.textContent = texto;
      fila.append(c);
    }
    cuerpo.append(fila);
  }
  t.append(cuerpo);
  det.append(t);
  return det;
}

function tarjeta(serie, tooltip) {
  const el = document.createElement("article");
  el.className = "tarjeta";
  const arriba = serie.direccion === "arriba";
  const base = serie.inicial ?? serie.puntos[0];
  const ultimo = serie.ultimo;
  const titulo = document.createElement("h3");
  titulo.textContent = `${serie.nombre} · ${LADOS[serie.lado]}`;
  const cifra = document.createElement("div");
  cifra.className = "cifra";
  const signo = serie.mejora > 0 ? "+" : "";
  const sesiones = serie.puntos.length;
  cifra.innerHTML = `${signo}${fmt(serie.mejora)} <small>desde tu primera calibración (${sesiones} ${sesiones === 1 ? "sesión" : "sesiones"})</small>`;
  const detalle = document.createElement("p");
  detalle.className = "nota";
  detalle.textContent = arriba
    ? `Empezaste llegando a ${fmt(base.mejor)} y hoy llegas a ${fmt(ultimo.mejor)} (récord ${fmt(serie.mejor_historico)}). ` +
      `Rango normal de referencia: ${fmt(serie.referencia)}; te faltan ${fmt(serie.faltante_referencia)}.`
    : `Empezaste estirando hasta ${fmt(base.mejor)} y hoy hasta ${fmt(ultimo.mejor)} (récord ${fmt(serie.mejor_historico)}). ` +
      `Pierna recta = 0°; en la gráfica, más arriba = más recta.`;
  const nota = document.createElement("p");
  nota.className = "nota";
  nota.textContent = "Cada punto es tu rango calibrado de una sesión (mediana de tus mejores intentos)." +
    (serie.puntos.some((p) => p.consistente === false) ? " Punto hueco / *: intentos poco consistentes." : "");
  el.append(titulo, cifra, detalle, grafica(serie, tooltip), nota, tabla(serie));
  return el;
}

export function dibujarProgreso(contenedor, series, tooltip) {
  contenedor.replaceChildren(...series.map((s) => tarjeta(s, tooltip)));
}
