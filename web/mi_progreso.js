// Pantalla «Mi progreso»: lo jugado cada día y la mejoría del rango, leídos de la base de datos
// (GET /api/pacientes/<código>/diario). Una sola medida por gráfica: las columnas son el tiempo
// jugado por día y las tarjetas de progreso.js, el rango calibrado de cada día. El color no
// distingue series (cada gráfica tiene una), y todo lo del tooltip también está en las tablas.
import { dibujarProgreso, formatoDia } from "./progreso.js";

const $ = (id) => document.getElementById(id);
const M = { izq: 52, der: 12, arriba: 22, abajo: 26 };
const ALTO = 240;
const ANCHO_MAX_COLUMNA = 24;
const PASOS_MIN = [0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120, 240];

/** Fecha local a partir de "AAAA-MM-DD" (new Date(texto) la tomaría en UTC y cambiaría de día). */
function aFecha(dia) {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(a, m - 1, d);
}

function aDia(fecha) {
  const dos = (n) => String(n).padStart(2, "0");
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

function sumarDias(dia, n) {
  const f = aFecha(dia);
  f.setDate(f.getDate() + n);
  return aDia(f);
}

export function duracion(segundos) {
  const s = Math.round(segundos);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60), resto = s % 60;
  if (h) return min ? `${h} h ${min} min` : `${h} h`;
  return resto ? `${min} min ${resto} s` : `${min} min`;
}

function svg(etiqueta, atributos = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", etiqueta);
  for (const [k, v] of Object.entries(atributos)) el.setAttribute(k, v);
  return el;
}

function texto(atributos, contenido) {
  const t = svg("text", atributos);
  t.textContent = contenido;
  return t;
}

/** Columna con la punta redondeada y la base recta, sobre la línea de base. */
function columna(x, y, ancho, base) {
  const r = Math.min(4, ancho / 2, base - y);
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + ancho - r} Q${x + ancho},${y} ${x + ancho},${y + r} V${base} Z`;
}

export class MiProgreso {
  /** @param {(metodo: string, url: string) => Promise<any>} api
   *  @param {(codigo: string) => Promise<void>} elegirJugador
   *  @param {HTMLElement} tooltip */
  constructor(api, elegirJugador, tooltip) {
    this.api = api;
    this.tooltip = tooltip;
    this.jugador = null;
    this.datos = null;
    this.periodo = 30; // días; null = todo
    this._anchoDibujado = 0;
    for (const b of $("periodo_progreso").querySelectorAll("[data-dias]")) {
      b.addEventListener("click", () => {
        this.periodo = b.dataset.dias === "todo" ? null : Number(b.dataset.dias);
        this._pintar();
      });
    }
    $("progreso_jugador").addEventListener("change", async (e) => {
      await elegirJugador(e.target.value);
      this.mostrar(e.target.value || null);
    });
    $("btn_descargar_progreso").addEventListener("click", () => this._descargar());
    new ResizeObserver(() => {
      const ancho = $("grafica_tiempo").clientWidth;
      if (ancho && ancho !== this._anchoDibujado && this.datos) this._graficaTiempo();
    }).observe($("grafica_tiempo"));
  }

  /** Al abrir la pantalla: siempre lee de la base de datos, para incluir lo último que se jugó. */
  async mostrar(jugador) {
    this.jugador = jugador;
    $("progreso_jugador").value = jugador ?? "";
    this.datos = null;
    if (jugador) {
      try {
        this.datos = await this.api("GET", `/pacientes/${encodeURIComponent(jugador)}/diario`);
      } catch (e) {
        this._vacio(`No se pudo leer el progreso: ${e.message}`);
        return;
      }
    }
    this._pintar();
  }

  _vacio(mensaje) {
    $("progreso_mensaje").textContent = mensaje;
    $("progreso_mensaje").classList.remove("oculto");
    $("contenido_progreso").classList.add("oculto");
    $("btn_descargar_progreso").disabled = true;
  }

  _pintar() {
    for (const b of $("periodo_progreso").querySelectorAll("[data-dias]")) {
      const dias = b.dataset.dias === "todo" ? null : Number(b.dataset.dias);
      b.setAttribute("aria-checked", String(dias === this.periodo));
    }
    if (!this.jugador) return this._vacio("Elige un jugador para ver su progreso.");
    if (!this.datos?.dias.length) return this._vacio(`${this.jugador} todavía no tiene datos guardados. ¡Juega una sesión y aparecerán aquí!`);
    $("progreso_mensaje").classList.add("oculto");
    $("contenido_progreso").classList.remove("oculto");
    $("btn_descargar_progreso").disabled = false;

    const hoy = aDia(new Date());
    this.desde = this.periodo ? sumarDias(hoy, 1 - this.periodo) : this.datos.dias[0].dia;
    this.hoy = hoy;
    this.diasPeriodo = this.datos.dias.filter((d) => d.dia >= this.desde);
    this._cifras();
    this._graficaTiempo();
    this._tablaDias();
    this._mejoria();
  }

  _cifras() {
    const suma = (campo) => this.diasPeriodo.reduce((t, d) => t + d[campo], 0);
    const deHoy = this.diasPeriodo.find((d) => d.dia === this.hoy);
    const cifras = [
      ["Tiempo jugado", duracion(suma("segundos"))],
      ["Hoy", duracion(deHoy?.segundos ?? 0)],
      ["Días con juego", String(this.diasPeriodo.length)],
      ["Series", String(suma("series"))],
      ["Repeticiones válidas", `${suma("validas")} de ${suma("intentadas")}`],
    ];
    $("cifras_progreso").replaceChildren(...cifras.map(([rotulo, valor]) => {
      const c = document.createElement("div");
      c.append(Object.assign(document.createElement("span"), { className: "etiqueta", textContent: rotulo }),
        Object.assign(document.createElement("strong"), { textContent: valor }));
      return c;
    }));
    const sinTiempo = suma("sin_tiempo");
    $("nota_tiempo").textContent = sinTiempo
      ? `${sinTiempo} ${sinTiempo === 1 ? "resultado guardado" : "resultados guardados"} antes de medir el tiempo no se ${sinTiempo === 1 ? "cuenta" : "cuentan"} aquí.`
      : "";
  }

  /** Columnas: un día del calendario por columna, también los días sin juego. */
  _graficaTiempo() {
    const cont = $("grafica_tiempo");
    const ANCHO = cont.clientWidth;
    if (!ANCHO) return;
    this._anchoDibujado = ANCHO;
    const porDia = new Map(this.diasPeriodo.map((d) => [d.dia, d]));
    const dias = [];
    for (let d = this.desde; d <= this.hoy; d = sumarDias(d, 1)) dias.push(d);
    const minutos = (d) => (porDia.get(d)?.segundos ?? 0) / 60;
    const maximo = Math.max(1, ...dias.map(minutos));
    const paso = PASOS_MIN.find((p) => maximo / p <= 4) ?? 480;
    const tope = Math.ceil(maximo / paso) * paso;
    const ancho = ANCHO - M.izq - M.der, alto = ALTO - M.arriba - M.abajo;
    const base = M.arriba + alto;
    const y = (m) => M.arriba + (1 - m / tope) * alto;
    const banda = ancho / dias.length;
    const grosor = Math.max(1, Math.min(ANCHO_MAX_COLUMNA, banda - 2)); // deja al menos 2 px entre columnas

    const raiz = svg("svg", { viewBox: `0 0 ${ANCHO} ${ALTO}`, width: ANCHO, height: ALTO, class: "grafica", role: "img",
      "aria-label": `Tiempo jugado por día, del ${formatoDia(this.desde)} al ${formatoDia(this.hoy)}. Los datos están en la tabla de abajo.` });
    for (let m = 0; m <= tope + 1e-6; m += paso) {
      raiz.append(svg("line", { class: "rejilla", x1: M.izq, x2: ANCHO - M.der, y1: y(m), y2: y(m) }));
      raiz.append(texto({ class: "eje", x: M.izq - 6, y: y(m) + 4, "text-anchor": "end" }, m === 0 ? "0" : `${m} min`));
    }
    // Fechas: tantas como quepan sin encimarse, y siempre la última (hoy).
    const cadaCuantas = Math.max(1, Math.ceil(56 / banda));
    dias.forEach((d, i) => {
      if ((dias.length - 1 - i) % cadaCuantas) return;
      raiz.append(texto({ class: "eje", x: Math.min(M.izq + banda * (i + 0.5), ANCHO - 26), y: ALTO - 8, "text-anchor": "middle" }, formatoDia(d)));
    });
    const mayor = dias.reduce((a, b) => (minutos(b) > minutos(a) ? b : a), dias[0]);
    dias.forEach((d, i) => {
      const dato = porDia.get(d);
      const x = M.izq + banda * i + (banda - grosor) / 2;
      const m = minutos(d);
      let marca = null;
      if (m > 0) {
        // Al menos 2 px de alto: unos segundos de juego también se deben ver.
        marca = svg("path", { class: "columna-tiempo", d: columna(x, Math.min(y(m), base - 2), grosor, base) });
        raiz.append(marca);
      }
      if (d === mayor && m > 0) {
        raiz.append(texto({ class: "valor-columna", x: Math.max(M.izq + 20, Math.min(x + grosor / 2, ANCHO - 34)), y: Math.min(y(m), base - 2) - 6, "text-anchor": "middle" }, duracion(m * 60)));
      }
      // La franja de todo el día es el objetivo del mouse: más fácil que apuntarle a la columna.
      const zona = svg("rect", { class: "zona-hover", x: M.izq + banda * i, y: M.arriba, width: banda, height: alto });
      const mostrar = (cx, cy) => {
        marca?.classList.add("activa");
        this.tooltip.textContent = `${formatoDia(d)} · ` + (dato
          ? `${duracion(dato.segundos)} · ${dato.series} ${dato.series === 1 ? "serie" : "series"} · ${dato.validas} de ${dato.intentadas} repeticiones válidas`
          : "sin juego");
        this.tooltip.classList.remove("oculto");
        this.tooltip.style.left = `${Math.min(cx + 12, innerWidth - 300)}px`;
        this.tooltip.style.top = `${cy + 12}px`;
      };
      zona.addEventListener("pointermove", (e) => mostrar(e.clientX, e.clientY));
      zona.addEventListener("pointerleave", () => { marca?.classList.remove("activa"); this.tooltip.classList.add("oculto"); });
      raiz.append(zona);
    });
    cont.replaceChildren(raiz);
  }

  _tablaDias() {
    const filas = [...this.diasPeriodo].reverse().map((d) => {
      const fila = document.createElement("tr");
      for (const valor of [formatoDia(d.dia), d.segundos ? duracion(d.segundos) : d.sin_tiempo ? "sin dato" : "0 s",
        String(d.series), d.intentadas ? `${d.validas}/${d.intentadas}` : "–", String(d.calibraciones)]) {
        fila.append(Object.assign(document.createElement("td"), { textContent: valor }));
      }
      return fila;
    });
    $("tabla_dias").replaceChildren(...filas);
  }

  /** Una tarjeta por ejercicio y pierna: el rango de cada día del periodo y cuánto ganó en él. */
  _mejoria() {
    const series = this.datos.series.map((serie) => {
      const puntos = serie.puntos.filter((p) => p.dia >= this.desde);
      if (!puntos.length) return null;
      const signo = serie.direccion === "arriba" ? 1 : -1;
      const inicial = puntos[0], ultimo = puntos.at(-1);
      return { ...serie, puntos, inicial, ultimo, mejora: Math.round(signo * (ultimo.mejor - inicial.mejor) * 10) / 10 };
    }).filter(Boolean);
    $("mejoria_vacia").classList.toggle("oculto", series.length > 0);
    dibujarProgreso($("tarjetas_diarias"), series, this.tooltip, {
      porDia: true,
      desde: this.periodo ? `en los últimos ${this.periodo} días` : "desde tu primera calibración",
    });
  }

  /** Todos los datos del jugador en un CSV para Excel (separador «;» y coma decimal, como en Colombia). */
  _descargar() {
    const { dias, series } = this.datos;
    const claves = series.map((s) => `${s.nombre} (${s.lado === "der" ? "derecha" : "izquierda"}) · rango en grados`);
    const numero = (v) => (v == null ? "" : String(v).replace(".", ","));
    const lineas = [["Día", "Minutos jugados", "Series", "Repeticiones válidas", "Repeticiones intentadas", "Calibraciones", "Resultados sin tiempo", ...claves].join(";")];
    for (const d of dias) {
      const rangos = series.map((s) => numero(s.puntos.find((p) => p.dia === d.dia)?.mejor));
      lineas.push([d.dia, numero(Math.round((d.segundos / 60) * 10) / 10), d.series, d.validas, d.intentadas, d.calibraciones, d.sin_tiempo, ...rangos].join(";"));
    }
    const enlace = document.createElement("a");
    enlace.href = URL.createObjectURL(new Blob([`﻿${lineas.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" }));
    enlace.download = `vera_progreso_${this.jugador}.csv`;
    enlace.click();
    URL.revokeObjectURL(enlace.href);
  }
}
