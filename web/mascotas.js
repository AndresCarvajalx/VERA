// Personajes del menú de inicio: de vez en cuando uno se asoma por una esquina o un costado,
// saluda con la mano (con un globo de diálogo), mira hacia el cursor y vuelve a esconderse.
// Si se le hace clic, salta y responde.
import * as THREE from "./vendor/three.module.min.js";
import { poseQuieta, poseSaludo } from "./guia.js";
import { Toribara, cargarModelo } from "./toribara.js";

const FRASES = ["¡Hola!", "¿Listo para moverte?", "¡Vamos a entrenar!", "¡Tú puedes!", "¡Hoy toca estirar!",
  "¡Te estaba esperando!", "¡Elígeme a mí!"];
const RESPUESTAS = ["¡Hey! 👋", "¡Jaja, cosquillas!", "¡Juguemos!", "¡Aquí estoy!"];
const DURACION = { entra: 700, saluda: 2600, sale: 650 };

// Lugares desde donde se asoman. borde: hacia dónde se esconden; inclina: se ladean al asomarse
// desde un costado, como quien se asoma por una puerta.
const LUGARES = [
  { nombre: "abajo_izq", borde: "abajo", lado: -1 },
  { nombre: "abajo_der", borde: "abajo", lado: 1 },
  { nombre: "izquierda", borde: "costado", lado: -1 },
  { nombre: "derecha", borde: "costado", lado: 1 },
];

const suave = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, x)));

export class Mascotas {
  /**
   * @param {HTMLCanvasElement} lienzo lienzo a pantalla completa (sin eventos de puntero)
   * @param {HTMLElement} globo elemento del globo de diálogo
   * @param {string[]} claves personajes a usar
   */
  constructor(lienzo, globo, claves) {
    this.lienzo = lienzo;
    this.globo = globo;
    this.claves = claves;
    this.renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.escena = new THREE.Scene();
    this.camara = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    this.camara.position.set(0, 0, 9);
    this.escena.add(new THREE.HemisphereLight(0xffffff, 0x3a1a7a, 2.2));
    const frente = new THREE.DirectionalLight(0xffffff, 1.6);
    frente.position.set(0, 2, 6);
    this.escena.add(frente);
    this.mascotas = [];
    this.activos = new Map(); // lugar → estado de la mascota que se asoma ahí
    this.mouse = new THREE.Vector2(0, 0);
    this._proxima = performance.now() + 900;
    this._corriendo = false;
    addEventListener("resize", () => this._ajustar());
    addEventListener("pointermove", (e) => {
      this.mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    });
    addEventListener("click", (e) => this._clic(e));
    this._ajustar();
  }

  async cargar() {
    const modelos = await Promise.all(this.claves.map((c) => cargarModelo(`modelos/${c}.glb`)));
    this.mascotas = modelos.map((m, i) => {
      const t = new Toribara(this.escena, m);
      t.ocultar();
      return { clave: this.claves[i], t, ocupada: false };
    });
  }

  activar(si) {
    if (si && !this._corriendo) {
      this._corriendo = true;
      this._ajustar();
      this.renderer.setAnimationLoop((t) => this._cuadro(t));
    } else if (!si && this._corriendo) {
      this._corriendo = false;
      this.renderer.setAnimationLoop(null);
      this.globo.classList.add("oculto");
    }
  }

  _ajustar() {
    const ancho = innerWidth, alto = innerHeight;
    this.renderer.setSize(ancho, alto, false);
    this.camara.aspect = ancho / alto;
    this.camara.updateProjectionMatrix();
    // Mitad del área visible en el plano z = 0, para ubicar a las mascotas en los bordes.
    this.medioAlto = Math.tan(THREE.MathUtils.degToRad(this.camara.fov / 2)) * this.camara.position.z;
    this.medioAncho = this.medioAlto * this.camara.aspect;
  }

  /** Posición (x, y, inclinación) según el lugar y cuánto se asoma (0 escondida, 1 asomada). */
  _colocar(lugar, asomo) {
    const { medioAncho: W, medioAlto: H } = this;
    if (lugar.borde === "abajo") {
      const x = lugar.lado * (W - 1.0);
      const y = -H - 1.9 + asomo * 1.25; // asomada: se ve de los hombros para arriba
      return { x, y, inclina: 0, gira: -lugar.lado * 0.45 };
    }
    const x = lugar.lado * (W + 0.9 - asomo * 1.5);
    return { x, y: -H * 0.35 - 0.6, inclina: -lugar.lado * 0.32 * asomo, gira: -lugar.lado * 0.7 };
  }

  _empezar(ahora) {
    const libres = this.mascotas.filter((m) => !m.ocupada);
    const lugares = LUGARES.filter((l) => !this.activos.has(l.nombre));
    if (!libres.length || !lugares.length) return;
    const mascota = libres[Math.floor(Math.random() * libres.length)];
    const lugar = lugares[Math.floor(Math.random() * lugares.length)];
    mascota.ocupada = true;
    this.activos.set(lugar.nombre, {
      mascota, lugar, inicio: ahora, salto: 0,
      frase: FRASES[Math.floor(Math.random() * FRASES.length)],
    });
  }

  _cuadro(ahora) {
    if (!this.mascotas.length) return;
    // Rara vez hay más de dos a la vez, para no tapar el menú.
    if (ahora > this._proxima && this.activos.size < 2) {
      this._empezar(ahora);
      this._proxima = ahora + 2500 + Math.random() * 3500;
    }
    let globo = null;
    for (const [nombre, e] of this.activos) {
      const t = ahora - e.inicio;
      const { entra, saluda, sale } = DURACION;
      let asomo, saludando;
      if (t < entra) { asomo = suave(t / entra); saludando = false; }
      else if (t < entra + saluda) { asomo = 1; saludando = true; }
      else if (t < entra + saluda + sale) { asomo = 1 - suave((t - entra - saluda) / sale); saludando = false; }
      else {
        e.mascota.t.ocultar();
        e.mascota.ocupada = false;
        this.activos.delete(nombre);
        continue;
      }
      const brazo = -e.lugar.lado; // saluda con el brazo que da hacia el centro de la pantalla
      const pts = saludando ? poseSaludo(t, brazo) : poseQuieta(t);
      const { x, y, inclina, gira } = this._colocar(e.lugar, asomo);
      const g = e.mascota.t.grupo;
      // Mira un poco hacia el cursor.
      g.rotation.set(0, gira + this.mouse.x * 0.35, inclina);
      e.mascota.t.actualizar(pts);
      const salto = e.salto > ahora ? Math.sin(((e.salto - ahora) / 500) * Math.PI) * 0.35 : 0;
      g.position.set(x, y + salto, 0);
      if (saludando || e.salto > ahora) globo = { e, frase: e.salto > ahora ? e.respuesta : e.frase };
    }
    this._mostrarGlobo(globo);
    this.renderer.render(this.escena, this.camara);
  }

  _cabezaEnPantalla(e) {
    const cabeza = e.mascota.t.huesos.cabeza.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.55, 0));
    cabeza.project(this.camara);
    return { x: (cabeza.x + 1) / 2 * innerWidth, y: (1 - cabeza.y) / 2 * innerHeight };
  }

  _mostrarGlobo(globo) {
    if (!globo) { this.globo.classList.add("oculto"); return; }
    const { x, y } = this._cabezaEnPantalla(globo.e);
    this.globo.textContent = globo.frase;
    this.globo.style.left = `${Math.max(90, Math.min(innerWidth - 90, x))}px`;
    this.globo.style.top = `${Math.max(60, y)}px`;
    this.globo.classList.remove("oculto");
  }

  /** Clic cerca de una mascota asomada: salta y responde. */
  _clic(evento) {
    if (!this._corriendo) return;
    for (const e of this.activos.values()) {
      const { x, y } = this._cabezaEnPantalla(e);
      if (Math.hypot(evento.clientX - x, evento.clientY - (y + 90)) < 140) {
        e.salto = performance.now() + 500;
        e.respuesta = RESPUESTAS[Math.floor(Math.random() * RESPUESTAS.length)];
        e.inicio = Math.min(e.inicio, performance.now() - DURACION.entra); // se queda saludando un rato más
      }
    }
  }
}
