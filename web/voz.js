// Voz que guía la sesión: el jugador hace los ejercicios lejos de la pantalla (a 2–3 m, de lado) y
// no siempre puede leer las instrucciones. Usa las voces del navegador (speechSynthesis).
//
// Solo habla con una voz en español: si el equipo no tiene ninguna, se calla. Antes, sin voz en
// español, el navegador leía el texto con la voz inglesa del sistema y sonaba con acento inglés.
// Entre las voces en español elige la de mejor calidad: las "naturales" en línea de Edge, luego las
// de Google en Chrome, luego las instaladas en Windows. En Ajustes se puede elegir otra.
import { sonido } from "./sonido.js";

const CLAVE = "voz";
const CLAVE_NOMBRE = "voz_nombre";
const REPETIR_AVISO_MS = 6000; // un mismo aviso no se repite antes de esto
const ACENTO = ["es-co", "es-mx", "es-us", "es-419"]; // primero las de Latinoamérica

function leer(clave) {
  try { return localStorage.getItem(clave); } catch { return null; }
}
function guardar(clave, valor) {
  try { if (valor == null) localStorage.removeItem(clave); else localStorage.setItem(clave, valor); } catch { /* sin almacenamiento */ }
}

/** Puntaje de calidad de una voz en español (más es mejor). */
export function calidad(v) {
  const nombre = v.name.toLowerCase();
  let puntos = 0;
  if (nombre.includes("natural")) puntos += 40; // Edge: «Microsoft Dalia Online (Natural)»
  else if (nombre.includes("online")) puntos += 30;
  if (nombre.includes("google")) puntos += 25; // Chrome: «Google español de Estados Unidos»
  if (!v.localService) puntos += 5; // las de la nube suelen sonar mejor que las instaladas
  const acento = ACENTO.indexOf(v.lang.toLowerCase().replace("_", "-"));
  if (acento >= 0) puntos += 8 - acento * 2;
  return puntos;
}

class Voz {
  constructor() {
    this.disponible = "speechSynthesis" in window;
    this.activa = leer(CLAVE) !== "0";
    this.voces = []; // voces en español, de mejor a peor
    this._voz = null;
    this._ultimo = { texto: "", t: 0 };
    this._oyentes = new Set();
    if (this.disponible) {
      this._cargarVoces();
      // Las voces llegan después de cargar la página (y las de la nube, un poco más tarde).
      speechSynthesis.addEventListener("voiceschanged", () => this._cargarVoces());
    }
  }

  /** Avisa cuando cambia la lista de voces (para el selector de Ajustes). */
  alCambiar(fn) { this._oyentes.add(fn); fn(); }

  _cargarVoces() {
    this.voces = speechSynthesis.getVoices()
      .filter((v) => v.lang.toLowerCase().startsWith("es"))
      .sort((a, b) => calidad(b) - calidad(a));
    const elegida = leer(CLAVE_NOMBRE);
    this._voz = this.voces.find((v) => v.name === elegida) ?? this.voces[0] ?? null;
    for (const fn of this._oyentes) fn();
  }

  get nombre() { return this._voz?.name ?? null; }

  /** Elige una voz por nombre; null vuelve a la elección automática (la de mejor calidad). */
  elegir(nombre) {
    guardar(CLAVE_NOMBRE, nombre);
    this._cargarVoces();
  }

  fijar(activa) {
    this.activa = activa;
    guardar(CLAVE, activa ? "1" : "0");
    if (!activa) this.callar();
  }

  /**
   * Dice un texto. `interrumpir`: corta lo que se estaba diciendo (una instrucción nueva vale más que
   * terminar la anterior). Los avisos repetidos se ignoran un rato para no ser insistente.
   */
  decir(texto, { interrumpir = true, forzar = false } = {}) {
    if (!this.disponible || !this._voz || !texto) return; // sin voz en español, mejor callar
    if (!forzar && (!this.activa || sonido.silencio)) return;
    const ahora = performance.now();
    if (!forzar && texto === this._ultimo.texto && ahora - this._ultimo.t < REPETIR_AVISO_MS) return;
    this._ultimo = { texto, t: ahora };
    if (interrumpir) speechSynthesis.cancel();
    // Los signos de abrir y los grados se leen mal: se limpian solo para la voz.
    const limpio = texto.replace(/[¡¿«»]/g, "").replace(/(\d+(?:[.,]\d+)?)°/g, "$1 grados").replace(/ · /g, ". ");
    const frase = new SpeechSynthesisUtterance(limpio);
    frase.voice = this._voz;
    frase.lang = this._voz.lang;
    frase.rate = 1;
    frase.pitch = 1.05;
    speechSynthesis.speak(frase);
  }

  callar() {
    if (this.disponible) speechSynthesis.cancel();
  }
}

export const voz = new Voz();
