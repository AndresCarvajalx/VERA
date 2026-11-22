// Informe de progreso para guardar como PDF: se arma en la página y se imprime con el diálogo del
// navegador («Guardar como PDF»). No necesita librerías ni sale nada del equipo.
//
// VERA no tiene fines de diagnóstico clínico: el informe lo dice al principio y al final, y solo
// describe lo medido (rango, tiempo, repeticiones), sin interpretarlo.
import { formatoDia } from "./progreso.js";

const $ = (id) => document.getElementById(id);
const LADOS = { der: "derecha", izq: "izquierda" };
const AVISO = "Este informe resume el uso del videojuego VERA y lo que midió una cámara web. No es un diagnóstico " +
  "clínico, no reemplaza la valoración de un profesional de la salud y no debe usarse para tomar decisiones de tratamiento.";
const METODO = "Los ángulos se estiman con una cámara web y un modelo de visión por computadora (MediaPipe Pose), con la " +
  "persona de perfil a la cámara. Pueden tener un error de varios grados según la luz, el encuadre y la ropa. El «rango " +
  "medido» de cada día es el resultado de la calibración del juego: la mediana de los mejores intentos sostenidos.";

function el(etiqueta, clase, texto) {
  const e = document.createElement(etiqueta);
  if (clase) e.className = clase;
  if (texto != null) e.textContent = texto;
  return e;
}

function svg(etiqueta, atributos = {}, contenido) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", etiqueta);
  for (const [k, v] of Object.entries(atributos)) e.setAttribute(k, v);
  if (contenido != null) e.textContent = contenido;
  return e;
}

function duracion(segundos) {
  const min = Math.round(segundos / 60);
  if (segundos < 60) return `${Math.round(segundos)} s`;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

const grados = (v) => `${Math.round(v * 10) / 10}°`;

/** Línea del rango medido por día, con la referencia de una persona sin limitación. Solo blanco y negro y un azul. */
function grafica(serie) {
  const A = 520, H = 170, M = { izq: 40, der: 70, arriba: 12, abajo: 26 };
  const valores = serie.puntos.map((p) => p.mejor);
  let lo = Math.min(...valores, serie.referencia, 0), hi = Math.max(...valores, serie.referencia);
  const holgura = Math.max(5, (hi - lo) * 0.1);
  lo -= holgura; hi += holgura;
  const arriba = serie.direccion === "arriba";
  const ancho = A - M.izq - M.der, alto = H - M.arriba - M.abajo;
  const y = (v) => M.arriba + (arriba ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo)) * alto;
  const x = (i) => M.izq + (serie.puntos.length === 1 ? ancho / 2 : (i / (serie.puntos.length - 1)) * ancho);
  const raiz = svg("svg", { viewBox: `0 0 ${A} ${H}`, class: "informe-grafica", role: "img",
    "aria-label": `Rango medido por día de ${serie.nombre}, pierna ${LADOS[serie.lado]}` });
  const paso = [5, 10, 15, 20, 30, 45].find((p) => (hi - lo) / p <= 5) ?? 60;
  for (let v = Math.ceil(lo / paso) * paso; v <= hi; v += paso) {
    raiz.append(svg("line", { x1: M.izq, x2: A - M.der, y1: y(v), y2: y(v), class: "rejilla" }));
    raiz.append(svg("text", { x: M.izq - 6, y: y(v) + 4, "text-anchor": "end", class: "eje" }, `${v}°`));
  }
  raiz.append(svg("line", { x1: M.izq, x2: A - M.der, y1: y(serie.referencia), y2: y(serie.referencia), class: "referencia" }));
  raiz.append(svg("text", { x: A - M.der + 6, y: y(serie.referencia) + 4, class: "eje" }, `normal ${grados(serie.referencia)}`));
  raiz.append(svg("polyline", { points: serie.puntos.map((p, i) => `${x(i)},${y(p.mejor)}`).join(" "), class: "linea" }));
  serie.puntos.forEach((p, i) => {
    // Hueco: calibración poco consistente (sus intentos variaron mucho), para leerla con cautela.
    raiz.append(svg("circle", { cx: x(i), cy: y(p.mejor), r: 3.5, class: p.consistente === false ? "punto hueco" : "punto" }));
    const cada = Math.ceil(serie.puntos.length / 8);
    if (i % cada === 0 || i === serie.puntos.length - 1) {
      raiz.append(svg("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "eje" }, formatoDia(p.dia)));
      raiz.append(svg("text", { x: x(i), y: y(p.mejor) - 8, "text-anchor": "middle", class: "valor" }, grados(p.mejor)));
    }
  });
  return raiz;
}

function tabla(encabezados, filas) {
  const t = el("table");
  const cabeza = el("tr");
  for (const e of encabezados) cabeza.append(el("th", null, e));
  t.append(el("thead"), el("tbody"));
  t.tHead.append(cabeza);
  for (const fila of filas) {
    const tr = el("tr");
    for (const v of fila) tr.append(el("td", null, v));
    t.tBodies[0].append(tr);
  }
  return t;
}

/**
 * Arma el informe y abre el diálogo de impresión.
 * @param {{jugador: string, dias: object[], series: object[], logros: object|null, desde: string, hasta: string, periodo: string}} d
 */
export function imprimirInforme(d) {
  const raiz = $("informe");
  const suma = (campo) => d.dias.reduce((t, x) => t + x[campo], 0);
  const generado = new Date().toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short" });

  const cabecera = el("header", "informe-cabecera");
  const logo = Object.assign(el("img"), { src: "logo_sobrio.svg", alt: "VERA" });
  const titulos = el("div");
  titulos.append(el("h1", null, "Informe de uso y progreso"),
    el("p", null, `Jugador: ${d.jugador} · Periodo: ${d.periodo} (${formatoDia(d.desde)} a ${formatoDia(d.hasta)}) · Generado el ${generado}`));
  cabecera.append(logo, titulos);

  const aviso = el("p", "informe-aviso");
  aviso.append(el("strong", null, "Sin fines de diagnóstico clínico. "), AVISO);

  const resumen = el("section");
  resumen.append(el("h2", null, "Resumen del periodo"));
  const cifras = el("div", "informe-cifras");
  const datosCifras = [
    ["Días con juego", String(d.dias.length)],
    ["Tiempo en movimiento", duracion(suma("segundos"))],
    ["Series completadas", String(suma("series"))],
    ["Repeticiones válidas", `${suma("validas")} de ${suma("intentadas")}`],
  ];
  if (d.logros) {
    datosCifras.push(["Racha actual", `${d.logros.racha} ${d.logros.racha === 1 ? "día" : "días"}`],
      ["Logros", `${d.logros.logros.filter((l) => l.obtenido).length} de ${d.logros.logros.length}`]);
  }
  for (const [rotulo, valor] of datosCifras) {
    const c = el("div");
    c.append(el("span", null, rotulo), el("strong", null, valor));
    cifras.append(c);
  }
  resumen.append(cifras);

  const rangos = el("section");
  rangos.append(el("h2", null, "Rango medido por ejercicio"));
  if (!d.series.length) rangos.append(el("p", null, "No hubo calibraciones en este periodo."));
  for (const s of d.series) {
    const bloque = el("article", "informe-serie");
    const signo = s.direccion === "arriba" ? 1 : -1;
    const cambio = Math.round(signo * (s.ultimo.mejor - s.inicial.mejor) * 10) / 10;
    bloque.append(el("h3", null, `${s.nombre} · pierna ${LADOS[s.lado]}`),
      el("p", null, `Primera medición del periodo: ${grados(s.inicial.mejor)} (${formatoDia(s.inicial.dia)}). ` +
        `Última: ${grados(s.ultimo.mejor)} (${formatoDia(s.ultimo.dia)}). ` +
        `Diferencia: ${cambio > 0 ? "+" : ""}${grados(cambio)} hacia el rango de referencia. ` +
        `Referencia de una persona sin limitación: ${grados(s.referencia)}.`),
      grafica(s));
    if (s.puntos.some((p) => p.consistente === false)) {
      bloque.append(el("p", "informe-nota", "Círculo vacío: calibración poco consistente (los intentos de ese día variaron más de 8° entre sí); su valor es menos fiable."));
    }
    rangos.append(bloque);
  }

  const porDia = el("section");
  porDia.append(el("h2", null, "Detalle por día"),
    tabla(["Día", "Tiempo", "Series", "Repeticiones válidas", "Calibraciones"],
      d.dias.map((x) => [formatoDia(x.dia), x.segundos ? duracion(x.segundos) : "–", String(x.series),
        x.intentadas ? `${x.validas} de ${x.intentadas}` : "–", String(x.calibraciones)])));

  const notas = el("section", "informe-notas");
  notas.append(el("h2", null, "Cómo se midió"), el("p", null, METODO), el("p", "informe-aviso", AVISO));

  raiz.replaceChildren(cabecera, aviso, resumen, rangos, porDia, notas);

  // El título de la página es el nombre que el navegador propone para el PDF.
  const titulo = document.title;
  document.title = `Informe VERA ${d.jugador} ${d.hasta}`;
  window.addEventListener("afterprint", () => { document.title = titulo; }, { once: true });
  window.print();
}

/** Fila de indicador: nombre, valor medido, meta y si se cumple (con texto, no solo color). */
function filaIndicador(nombre, valor, meta, cumple, n) {
  return [nombre, valor ?? "sin datos", meta, cumple == null ? "–" : cumple ? "Cumple" : "No cumple", n];
}

/**
 * Informe técnico del prototipo (indicadores del OE4) con los datos de todos los jugadores:
 * precisión frente al goniómetro, fluidez, latencia y usabilidad. GET /api/indicadores.
 */
export function imprimirInformeTecnico(d) {
  const raiz = $("informe");
  const generado = new Date().toLocaleString("es-CO", { dateStyle: "long", timeStyle: "short" });
  const cabecera = el("header", "informe-cabecera");
  const titulos = el("div");
  titulos.append(el("h1", null, "Informe técnico del prototipo"),
    el("p", null, `Indicadores del objetivo específico 4 con los datos de todos los jugadores · Generado el ${generado}`));
  cabecera.append(Object.assign(el("img"), { src: "logo_sobrio.svg", alt: "VERA" }), titulos);
  const aviso = el("p", "informe-aviso");
  aviso.append(el("strong", null, "Sin fines de diagnóstico clínico. "),
    "Este informe evalúa el funcionamiento técnico del videojuego (precisión de la medición, fluidez, tiempo de respuesta y facilidad de uso). No contiene ni interpreta información clínica de los jugadores.");

  const p = d.precision.total;
  const resumen = el("section");
  resumen.append(el("h2", null, "Indicadores"), tabla(["Indicador", "Medido", "Meta", "Resultado", "Muestras"], [
    filaIndicador("Error absoluto medio frente al goniómetro", p ? `${p.error_absoluto_medio}°` : null, `≤ ${d.precision.meta}°`,
      p ? p.cumple_meta : null, p ? `${p.n} mediciones de ${d.precision.jugadores} ${d.precision.jugadores === 1 ? "jugador" : "jugadores"}` : "0"),
    filaIndicador("Fotogramas por segundo (promedio)", d.fps.promedio == null ? null : `${d.fps.promedio} FPS`, `≥ ${d.fps.meta} FPS`,
      d.fps.promedio == null ? null : d.fps.promedio >= d.fps.meta, `${d.fps.n} actividades · ${d.fps.porcentaje_cumple ?? "–"} % cumple`),
    filaIndicador("Latencia de la cámara a la pantalla (promedio)", d.latencia.promedio == null ? null : `${d.latencia.promedio} ms`,
      `≤ ${d.latencia.meta} ms`, d.latencia.promedio == null ? null : d.latencia.promedio <= d.latencia.meta,
      `${d.latencia.n} sesiones${d.latencia.p95_promedio == null ? "" : ` · p95 ${d.latencia.p95_promedio} ms`}`),
    filaIndicador("Usabilidad (SUS, promedio)", d.sus.promedio == null ? null : `${d.sus.promedio}`, `≥ ${d.sus.meta}`,
      d.sus.promedio == null ? null : d.sus.promedio >= d.sus.meta, `${d.sus.n} ${d.sus.n === 1 ? "encuesta" : "encuestas"}`),
  ]));

  const precision = el("section");
  precision.append(el("h2", null, "Precisión por articulación"));
  const articulaciones = Object.entries(d.precision.por_articulacion);
  precision.append(articulaciones.length
    ? tabla(["Articulación", "Mediciones", "Error absoluto medio", "Sesgo", "Desviación del error", "Error máximo"],
      articulaciones.map(([a, r]) => [a[0].toUpperCase() + a.slice(1), String(r.n), `${r.error_absoluto_medio}°`,
        `${r.sesgo > 0 ? "+" : ""}${r.sesgo}°`, `${r.desviacion_error}°`, `${r.error_maximo}°`]))
    : el("p", null, "Todavía no hay mediciones con goniómetro. Se registran en el panel del fisioterapeuta."));

  const metodo = el("section", "informe-notas");
  metodo.append(el("h2", null, "Cómo se midió"),
    el("p", null, "Precisión: el fisioterapeuta mide el ángulo con un goniómetro mientras el jugador sostiene una posición, y el sistema guarda la mediana de su último segundo de medición. Error = sistema − goniómetro; el sesgo positivo indica que el sistema mide de más."),
    el("p", null, "Fluidez: promedio de fotogramas por segundo procesados en cada calibración y serie. Latencia: tiempo desde que la cámara captura un fotograma hasta que la página lo dibuja, promediado por sesión; p95 es el valor bajo el cual quedó el 95 % de los fotogramas."),
    el("p", null, "Usabilidad: System Usability Scale (Brooke, 1996), diez afirmaciones de 1 a 5 con puntaje de 0 a 100; cuenta la encuesta más reciente de cada jugador."),
    el("p", "informe-aviso", "Los datos de jugadores de prueba o inventados para demostraciones también entran en estos promedios: revisa qué jugadores se incluyen antes de reportarlos."));

  raiz.replaceChildren(cabecera, aviso, resumen, precision, metodo);
  const titulo = document.title;
  document.title = `Informe técnico VERA ${new Date().toISOString().slice(0, 10)}`;
  window.addEventListener("afterprint", () => { document.title = titulo; }, { once: true });
  window.print();
}
