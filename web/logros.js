// Racha de días seguidos y logros del jugador (GET /api/pacientes/<código>/logros).
// Se muestran en «Mi progreso», en la barra de la sesión y, cuando se gana uno, en un aviso.
import { sonido } from "./sonido.js";
import { voz } from "./voz.js";

const $ = (id) => document.getElementById(id);

function icono(nombre) {
  const s = Object.assign(document.createElement("span"), { className: "icono" });
  s.dataset.icono = nombre;
  s.setAttribute("aria-hidden", "true");
  return s;
}

export class Logros {
  /** @param {(metodo: string, url: string) => Promise<any>} api */
  constructor(api) {
    this.api = api;
    this.obtenidos = new Map(); // jugador → claves ya obtenidas, para avisar solo de los nuevos
  }

  async cargar(jugador) {
    const datos = await this.api("GET", `/pacientes/${encodeURIComponent(jugador)}/logros`);
    if (!this.obtenidos.has(jugador)) this.obtenidos.set(jugador, new Set(datos.logros.filter((l) => l.obtenido).map((l) => l.clave)));
    return datos;
  }

  /** Vuelve a leer los logros y avisa de los que se ganaron desde la última vez. */
  async revisar(jugador) {
    let datos;
    try { datos = await this.cargar(jugador); } catch { return; }
    const antes = this.obtenidos.get(jugador);
    const nuevos = datos.logros.filter((l) => l.obtenido && !antes.has(l.clave));
    for (const l of nuevos) antes.add(l.clave);
    this.pintarRacha($("sesion_racha"), datos);
    nuevos.forEach((l, i) => setTimeout(() => this._aviso(l), 2200 + i * 3800));
  }

  /** Chip con la llama y los días seguidos (se oculta si no hay racha). */
  pintarRacha(el, { racha, jugo_hoy: jugoHoy }) {
    el.classList.toggle("oculto", !racha);
    el.classList.toggle("encendida", jugoHoy);
    el.replaceChildren(icono("llama"), `${racha} ${racha === 1 ? "día" : "días"} de racha`);
    el.title = jugoHoy ? "Ya jugaste hoy: tu racha sigue." : "Juega hoy para no perder tu racha.";
  }

  /** Sección de «Mi progreso»: racha grande y la vitrina de logros. */
  pintar(datos) {
    $("racha_numero").textContent = datos.racha;
    $("racha_unidad").textContent = datos.racha === 1 ? "día seguido" : "días seguidos";
    $("racha_texto").textContent = datos.racha === 0 ? "Juega hoy para empezar una racha."
      : datos.jugo_hoy ? "¡Ya jugaste hoy! Vuelve mañana para seguir sumando."
        : "Juega hoy para no perder tu racha.";
    $("racha_mejor").textContent = `Tu mejor racha: ${datos.mejor_racha} ${datos.mejor_racha === 1 ? "día" : "días"}`;
    $("tarjeta_racha").classList.toggle("encendida", datos.racha > 0);
    const ganados = datos.logros.filter((l) => l.obtenido).length;
    $("logros_cuenta").textContent = `${ganados} de ${datos.logros.length}`;
    $("lista_logros").replaceChildren(...datos.logros.map((l) => {
      const li = Object.assign(document.createElement("li"), { className: `logro${l.obtenido ? " obtenido" : ""}` });
      const medalla = Object.assign(document.createElement("span"), { className: "medalla" });
      medalla.append(icono(l.obtenido ? l.icono : "candado"));
      const texto = document.createElement("div");
      texto.append(Object.assign(document.createElement("strong"), { textContent: l.nombre }),
        Object.assign(document.createElement("small"), { textContent: l.descripcion }));
      if (!l.obtenido) {
        const barra = Object.assign(document.createElement("div"), { className: "avance-logro" });
        barra.append(Object.assign(document.createElement("div"), { style: `width: ${(l.avance / l.meta) * 100}%` }));
        texto.append(barra, Object.assign(document.createElement("small"), {
          className: "cifra-logro", textContent: `${Math.floor(l.avance)} de ${l.meta}`,
        }));
      }
      li.append(medalla, texto);
      return li;
    }));
  }

  _aviso(logro) {
    const aviso = $("aviso_logro");
    aviso.replaceChildren(Object.assign(document.createElement("span"), { className: "medalla" }),
      Object.assign(document.createElement("div"), { className: "texto-logro" }));
    aviso.firstChild.append(icono(logro.icono));
    aviso.lastChild.append(Object.assign(document.createElement("small"), { textContent: "Logro nuevo" }),
      Object.assign(document.createElement("strong"), { textContent: logro.nombre }));
    aviso.classList.remove("ver");
    void aviso.offsetWidth;
    aviso.classList.add("ver");
    sonido.efecto("serie");
    voz.decir(`Logro nuevo: ${logro.nombre}`, { interrumpir: false });
  }
}
