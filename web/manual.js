// Manual de usuario: los ejercicios con una demostración en 3D del rango normal y la tabla de
// límites de movimiento (config/reglas_rom.json → rangos_referencia, Kapandji).
import { cicloGuia, poseGuia } from "./guia.js";
import { Vitrina } from "./vitrina.js";

const POSICION = { de_pie: "De pie", sentado: "Sentado" };

export class Manual {
  /**
   * @param {object} opciones
   * @param {object[]} opciones.ejercicios catálogo de /api/ejercicios
   * @param {object} opciones.guias cómo demuestra la guía cada ejercicio ({articulacion, sentido})
   * @param {(regla: object) => number} opciones.rangoNormal
   */
  constructor({ ejercicios, guias, rangoNormal }) {
    this.ejercicios = ejercicios;
    this.guias = guias;
    this.rangoNormal = rangoNormal;
    this.demo = null;
    this.actual = null;
    this._inicio = 0;
    this._pintarLista();
  }

  _pintarLista() {
    const lista = document.getElementById("lista_ejercicios_manual");
    lista.replaceChildren(...this.ejercicios.map((e) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ejercicio-manual";
      b.dataset.ejercicio = e.clave;
      b.setAttribute("aria-pressed", "false");
      b.append(
        Object.assign(document.createElement("strong"), { textContent: e.nombre }),
        Object.assign(document.createElement("span"), { textContent: e.descripcion }),
        Object.assign(document.createElement("small"), {
          textContent: `${POSICION[e.posicion]} · empieza ${e.posicion_inicial} · rango normal: ${this._textoRango(e)}`,
        }),
      );
      b.addEventListener("click", () => this.elegir(e.clave));
      return b;
    }));
  }

  _textoRango(e) {
    return e.direccion === "arriba" ? `hasta ${e.max_fisiologico}°` : "hasta dejar la pierna recta (0°)";
  }

  /** La demostración 3D se crea al abrir el manual la primera vez (no gasta GPU antes). */
  async mostrar(clavePersonaje) {
    if (!this.demo) {
      this.demo = new Vitrina(document.getElementById("demo_manual"), { pose: (t) => this._pose(t) });
      if (!this.actual) this.elegir(this.ejercicios[0]?.clave);
    }
    await this.demo.poner(clavePersonaje);
    this.demo.activar(true);
  }

  ocultar() { this.demo?.activar(false); }

  elegir(clave) {
    const e = this.ejercicios.find((x) => x.clave === clave);
    if (!e) return;
    this.actual = e;
    this._inicio = performance.now();
    for (const b of document.querySelectorAll(".ejercicio-manual")) {
      b.setAttribute("aria-pressed", String(b.dataset.ejercicio === clave));
    }
    document.getElementById("demo_texto").textContent =
      `${e.nombre}: ${e.descripcion} La guía llega ${this._textoRango(e)}, el rango de una persona sin limitación; ` +
      "sostiene un momento y vuelve despacio.";
  }

  _pose(t) {
    const e = this.actual;
    const guia = { ...this.guias[e.clave], lado: "der" };
    const normal = this.rangoNormal(e);
    // Sentado se parte de 90° de flexión y se estira hasta el ángulo normal (igual que en el juego).
    const objetivo = e.direccion === "arriba" ? normal : Math.max(0, 90 - normal);
    const { grados, fase } = cicloGuia(t - this._inicio, objetivo, 1000);
    const { pts, sentado } = poseGuia(guia, grados);
    // A tres cuartos, para que se vea el plano del movimiento.
    return { pts, sentado, giro: -0.75, resalte: { lado: "der", color: fase === "sostén" ? "#7cff4f" : "#ffe14d" } };
  }

  async cargarRangos(api) {
    const { fuente, rangos } = await api("GET", "/rangos");
    document.querySelector("#tabla_rangos tbody").replaceChildren(...rangos.map((r) => {
      const fila = document.createElement("tr");
      for (const valor of [r.articulacion, r.movimiento, r.condicion, r.activo, r.pasivo, r.clinico]) {
        fila.append(Object.assign(document.createElement("td"), { textContent: valor }));
      }
      return fila;
    }));
    document.getElementById("fuente_rangos").textContent = `Fuente: ${fuente.replace(/\.$/, "")}.`;
  }
}
