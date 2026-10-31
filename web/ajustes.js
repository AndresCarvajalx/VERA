// Ajustes: elegir la cámara (del equipo o la de un celular por URL) y probarla en vivo con el
// esqueleto que detecta el servicio. El video nunca llega al navegador.
const $ = (id) => document.getElementById(id);

function nombreFuente(fuente) {
  return typeof fuente === "number" ? `Cámara ${fuente} del equipo` : `Celular (${fuente})`;
}

export class Ajustes {
  /**
   * @param {(metodo: string, url: string, cuerpo?: object) => Promise<any>} api
   * @param {(msg: object, lienzo: HTMLCanvasElement) => void} dibujar esqueleto 2D
   */
  constructor(api, dibujar) {
    this.api = api;
    this.dibujar = dibujar;
    this.actual = null;
    this.ocupado = false;
    $("btn_buscar_camaras").addEventListener("click", () => this.buscar());
    $("btn_usar_url").addEventListener("click", () => {
      const url = $("url_camara").value.trim();
      if (!/^(https?|rtsp):\/\//i.test(url)) {
        this._mensaje("Escribe la dirección completa, empezando por http://, https:// o rtsp://", "mal");
        return;
      }
      this.usar(url);
    });
  }

  async mostrar() {
    try {
      const { actual } = await this.api("GET", "/camara");
      this._pintarActual(actual);
    } catch (e) {
      this._mensaje(`No se pudo leer la cámara: ${e.message}`, "mal");
    }
  }

  _pintarActual(actual) {
    this.actual = actual;
    $("camara_actual").textContent = nombreFuente(actual);
    for (const b of $("lista_camaras").querySelectorAll(".camara")) {
      b.setAttribute("aria-checked", String(Number(b.dataset.indice) === actual));
    }
    if (typeof actual === "string") $("url_camara").value = actual;
  }

  /** Revisa qué cámaras del equipo responden (tarda ~1 s por cámara). */
  async buscar() {
    if (this.ocupado) return;
    this.ocupado = true;
    $("btn_buscar_camaras").disabled = true;
    this._mensaje("Buscando cámaras…");
    try {
      const { actual, dispositivos } = await this.api("GET", "/camara");
      $("lista_camaras").replaceChildren(...dispositivos.map((d) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "camara";
        b.setAttribute("role", "radio");
        b.dataset.indice = d.indice;
        b.textContent = `Cámara ${d.indice}` + (d.en_uso ? " · en uso" : d.ancho ? ` · ${d.ancho}×${d.alto}` : "");
        b.addEventListener("click", () => this.usar(d.indice));
        return b;
      }));
      this._pintarActual(actual);
      this._mensaje(dispositivos.length ? `Encontré ${dispositivos.length} cámara(s). Pulsa una para usarla.`
        : "No encontré cámaras en el equipo.", dispositivos.length ? "ok" : "mal");
    } catch (e) {
      this._mensaje(`No se pudieron buscar cámaras: ${e.message}`, "mal");
    } finally {
      this.ocupado = false;
      $("btn_buscar_camaras").disabled = false;
    }
  }

  async usar(fuente) {
    if (this.ocupado || fuente === this.actual) return;
    this.ocupado = true;
    this._mensaje(`Conectando con ${nombreFuente(fuente).toLowerCase()}… (si no responde, puede tardar hasta medio minuto)`);
    try {
      const { actual } = await this.api("PUT", "/camara", { fuente });
      this._pintarActual(actual);
      this._mensaje(`Listo: ahora se usa ${nombreFuente(actual).toLowerCase()}. Ponte frente a ella para probarla.`, "ok");
    } catch (e) {
      this._mensaje(e.message, "mal");
    } finally {
      this.ocupado = false;
    }
  }

  /** Cada fotograma del servicio mientras la pantalla de ajustes está abierta. */
  fotograma(msg) {
    this.dibujar(msg, $("lienzo_ajustes"));
    $("fps_ajustes").textContent = msg.fps.toFixed(1);
    $("persona_ajustes").textContent = !msg.persona ? "No te veo" : msg.encuadre_ok ? "Cuerpo completo" : "Solo una parte";
    $("persona_ajustes").style.color = msg.persona && msg.encuadre_ok ? "var(--ok)" : "var(--mal)";
    const vista = msg.vista;
    $("vista_ajustes").textContent = !msg.persona ? "–" : vista?.lateral ? `De lado (pierna ${vista.lado_camara === "der" ? "derecha" : "izquierda"} hacia la cámara)` : "De frente";
  }

  _mensaje(texto, tipo = "") {
    const m = $("mensaje_ajustes");
    m.textContent = texto;
    m.className = `mensaje ${tipo}`;
  }
}
