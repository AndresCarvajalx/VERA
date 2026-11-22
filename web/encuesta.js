// Encuesta de usabilidad SUS (System Usability Scale, Brooke 1996): diez afirmaciones de 1 a 5.
// Mide qué tan fácil de usar es VERA (indicador del OE4: SUS ≥ 68). No pregunta nada de salud.
const $ = (id) => document.getElementById(id);

// Traducción al español de las diez afirmaciones originales, en su orden (impares positivas, pares negativas).
const AFIRMACIONES = [
  "Creo que me gustaría usar VERA con frecuencia.",
  "Encontré VERA innecesariamente complicado.",
  "Pensé que VERA era fácil de usar.",
  "Creo que necesitaría la ayuda de una persona con conocimientos técnicos para usar VERA.",
  "Las distintas partes de VERA estaban bien integradas.",
  "Pensé que VERA tenía demasiadas incoherencias.",
  "Imagino que la mayoría de las personas aprendería a usar VERA muy rápido.",
  "Encontré VERA muy difícil de usar.",
  "Me sentí muy seguro usando VERA.",
  "Necesité aprender muchas cosas antes de poder usar VERA.",
];
const ESCALA = ["Totalmente en desacuerdo", "En desacuerdo", "Ni de acuerdo ni en desacuerdo", "De acuerdo", "Totalmente de acuerdo"];

export class Encuesta {
  /** @param {(metodo: string, url: string, cuerpo?: object) => Promise<any>} api */
  constructor(api) {
    this.api = api;
    this.dialogo = $("dialogo_sus");
    $("lista_sus").replaceChildren(...AFIRMACIONES.map((texto, i) => {
      const grupo = Object.assign(document.createElement("fieldset"), { className: "pregunta-sus" });
      grupo.append(Object.assign(document.createElement("legend"), { textContent: `${i + 1}. ${texto}` }));
      const opciones = Object.assign(document.createElement("div"), { className: "escala-sus" });
      ESCALA.forEach((rotulo, v) => {
        const etiqueta = Object.assign(document.createElement("label"), { title: rotulo });
        const radio = Object.assign(document.createElement("input"), { type: "radio", name: `sus_${i}`, value: String(v + 1), required: true });
        etiqueta.append(radio, Object.assign(document.createElement("span"), { textContent: String(v + 1) }),
          Object.assign(document.createElement("small"), { textContent: rotulo }));
        opciones.append(etiqueta);
      });
      grupo.append(opciones);
      return grupo;
    }));
    $("cancelar_sus").addEventListener("click", () => this.dialogo.close("cancelada"));
  }

  /** ¿El jugador todavía no la respondió? */
  async pendiente(jugador) {
    if (!jugador) return false;
    const r = await this.api("GET", `/pacientes/${encodeURIComponent(jugador)}/sus`);
    return !r.respondida;
  }

  /** Abre la encuesta y la guarda al enviarla. Devuelve true si se respondió. */
  abrir(jugador) {
    const formulario = $("formulario_sus");
    formulario.reset();
    $("mensaje_sus").textContent = "";
    this.dialogo.showModal();
    return new Promise((resolver) => {
      const enviar = async (e) => {
        e.preventDefault();
        const respuestas = AFIRMACIONES.map((_, i) => Number(formulario.elements[`sus_${i}`].value));
        try {
          await this.api("POST", `/pacientes/${encodeURIComponent(jugador)}/sus`, { respuestas });
          this.dialogo.close("enviada");
        } catch (error) {
          $("mensaje_sus").textContent = `No se pudo guardar: ${error.message}`;
        }
      };
      formulario.addEventListener("submit", enviar);
      this.dialogo.addEventListener("close", () => {
        formulario.removeEventListener("submit", enviar);
        resolver(this.dialogo.returnValue === "enviada");
      }, { once: true });
    });
  }
}
