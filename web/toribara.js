// Los personajes elegibles (toribara, conejibara: modelado/generar_personajes.py) movidos con
// los puntos del jugador o de la guía. Todos comparten esqueleto, así que esta clase sirve para
// cualquiera (se llama Toribara porque fue el primero).
//
// Retargeting: cada hueso se gira para que su eje (el +Y local, que va de su articulación a la
// siguiente) apunte en la dirección del segmento correspondiente del esqueleto calculado por
// avatar.js. Solo cambia la orientación; los largos son los del modelo.
//
// Espejo: la escena se ve como un espejo, así que el lado derecho del jugador mueve el lado
// izquierdo del modelo (que en pantalla queda a la derecha).
import * as THREE from "./vendor/three.module.min.js";
import { GLTFLoader } from "./vendor/addons/loaders/GLTFLoader.js";
import { P } from "./avatar.js";

// Todos los personajes se muestran con la misma altura en la escena (la persona mide 1.70 m y los
// capibaras ~1.35 m con la cabeza), igual que el avatar de cilindros.
const ALTURA_EN_ESCENA = 1.72;
const ESPEJO = { izq: "der", der: "izq" }; // lado del jugador → lado del modelo
const ARRIBA = new THREE.Vector3(0, 1, 0);

// Hueso del modelo (lado del modelo) ← segmento del jugador (lado del jugador).
const SEGMENTOS = ["Izq", "Der"].flatMap((L) => {
  const m = ESPEJO[L.toLowerCase()];
  return [
    [`muslo_${m}`, P[`cadera${L}`], P[`rodilla${L}`]],
    [`pierna_${m}`, P[`rodilla${L}`], P[`tobillo${L}`]],
    [`pie_${m}`, P[`talon${L}`], P[`pie${L}`]],
    [`brazo_${m}`, P[`hombro${L}`], P[`codo${L}`]],
    [`antebrazo_${m}`, P[`codo${L}`], P[`muneca${L}`]],
  ];
});
// Orden en que se recorren (padres antes que hijos).
const ORDEN = ["raiz", "cadera_izq", "cadera_der", "columna", "cabeza", "hombro_izq", "hombro_der",
  "muslo_izq", "muslo_der", "pierna_izq", "pierna_der", "pie_izq", "pie_der",
  "brazo_izq", "brazo_der", "antebrazo_izq", "antebrazo_der"];

// Etapas de la pierna según el rango calibrado frente al normal (ver etapaPorAvance).
export const ETAPAS = ["vendada", "venda_parcial", "fortaleciendose", "en_forma"];

export function etapaPorAvance(fraccion) {
  if (fraccion == null) return null;
  if (fraccion < 0.4) return "vendada";
  if (fraccion < 0.7) return "venda_parcial";
  if (fraccion < 0.9) return "fortaleciendose";
  return "en_forma";
}

/** Cada instancia necesita su propia copia (tiene su propio esqueleto): se carga una vez por instancia. */
export function cargarModelo(url) {
  return new GLTFLoader().loadAsync(url);
}

export class Toribara {
  /**
   * @param {THREE.Scene} escena
   * @param {object} gltf resultado de GLTFLoader (cada instancia necesita su propia carga: tiene esqueleto)
   * @param {{guia?: boolean, color?: string}} opciones
   */
  constructor(escena, gltf, { guia = false, color } = {}) {
    this.grupo = new THREE.Group();
    this.modelo = gltf.scene;
    // Las mallas con esqueleto calculan su caja con las matrices de los huesos: hay que
    // actualizarlas antes, o la altura sale mal (0.47 m en lugar de 1.77 m para la persona).
    this.modelo.updateMatrixWorld(true);
    const caja = new THREE.Box3().setFromObject(this.modelo);
    this.modelo.scale.setScalar(ALTURA_EN_ESCENA / (caja.max.y - caja.min.y));
    this.grupo.add(this.modelo);
    escena.add(this.grupo);
    this.modelo.updateMatrixWorld(true);

    this.huesos = Object.fromEntries(ORDEN.map((n) => [n, this.modelo.getObjectByName(n)]));
    const faltan = ORDEN.filter((n) => !this.huesos[n]);
    if (faltan.length) throw new Error(`Al modelo le faltan huesos: ${faltan.join(", ")}`);
    // Pose de reposo: rotación local, y dirección y eje lateral en el espacio del modelo.
    this.reposoLocal = {};
    for (const n of ORDEN) this.reposoLocal[n] = this.huesos[n].quaternion.clone();
    this._qModeloInv = this.modelo.getWorldQuaternion(new THREE.Quaternion()).invert();
    const pos = (n) => this.huesos[n].getWorldPosition(new THREE.Vector3());
    // Eje izq→der de la pelvis en reposo: entre las articulaciones de cadera, que son el inicio de
    // cada muslo (los huesos cadera_* nacen los dos en el centro de la pelvis).
    this.ejeCaderaReposo = pos("muslo_der").sub(pos("muslo_izq")).normalize();
    this.altoPiso = Math.min(pos("pie_izq").y, pos("pie_der").y) - this.grupo.position.y;
    this.alturaRodilla = pos("pierna_izq").y; // el hueso pierna nace en la rodilla

    this.opcionales = {};
    this.modelo.traverse((o) => {
      if (o.name.startsWith("venda_") || o.name === "banda_entrenador") this.opcionales[o.name] = o;
      if (o.isMesh) {
        o.frustumCulled = false; // el esqueleto mueve la malla fuera de su caja original
        o.material = o.material.clone();
      }
    });
    this.materialesPierna = {};
    this.modelo.traverse((o) => {
      if (o.isMesh && o.material.name.startsWith("pelaje_pierna_")) {
        this.materialesPierna[o.material.name.slice("pelaje_pierna_".length)] = o.material;
      }
    });
    for (const m of Object.values(this.materialesPierna)) m.userData.colorBase = m.color.clone();

    for (const o of Object.values(this.opcionales)) o.visible = false;
    if (guia) this._comoGuia(color);
    this.guia = guia;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  /** La guía es un holograma del mismo personaje: color único translúcido y con banda. */
  _comoGuia(color) {
    this.opcionales.banda_entrenador.visible = true;
    const c = new THREE.Color(color);
    this.modelo.traverse((o) => {
      if (!o.isMesh || o.name === "banda_entrenador") return;
      o.material.color = c.clone().lerp(o.material.color, 0.25);
      o.material.emissive = c.clone();
      o.material.emissiveIntensity = 0.35;
      o.material.transparent = true;
      o.material.opacity = 0.72;
      o.material.depthWrite = false;
    });
  }

  /**
   * @param {THREE.Vector3[]} pts los 33 puntos en la escena (avatar.js: esqueletoEstable o guia.js)
   * @param {boolean[]} [visibles] los segmentos con un extremo no visible quedan en reposo
   */
  actualizar(pts, visibles) {
    // Los puntos vienen en el marco del grupo (la guía está girada a tres cuartos): se resuelve
    // todo con el grupo sin girar y luego se le devuelve su giro.
    const giroGrupo = this.grupo.quaternion.clone();
    this.grupo.quaternion.identity();
    this.grupo.updateMatrixWorld(true);
    this._resolver(pts, visibles);
    this.grupo.quaternion.copy(giroGrupo);
    this.grupo.updateMatrixWorld(true);
  }

  _resolver(pts, visibles) {
    const ve = (...i) => !visibles || i.every((k) => visibles[k]);
    const dir = (a, b) => pts[b].clone().sub(pts[a]).normalize();
    const mundo = {}; // rotación en mundo de cada hueso ya resuelto
    const padreMundo = (n) => {
      const padre = this.huesos[n].parent;
      return mundo[padre.name] ?? padre.getWorldQuaternion(new THREE.Quaternion());
    };
    const fijar = (n, objetivo) => {
      const qPadre = padreMundo(n);
      const q = qPadre.clone().multiply(this.reposoLocal[n]); // rotación si conserva la pose de reposo
      if (objetivo) {
        const actual = ARRIBA.clone().applyQuaternion(q);
        q.premultiply(this._q.setFromUnitVectors(actual, objetivo));
      }
      mundo[n] = q;
      this.huesos[n].quaternion.copy(qPadre.clone().invert().multiply(q));
    };

    // Raíz: gira la pelvis para que el eje de las caderas y el tronco coincidan con los del jugador.
    const caderas = pts[P.caderaIzq].clone().add(pts[P.caderaDer]).multiplyScalar(0.5);
    const hombros = pts[P.hombroIzq].clone().add(pts[P.hombroDer]).multiplyScalar(0.5);
    const tronco = hombros.sub(caderas).normalize();
    // Eje izq→der del modelo = del lado derecho al izquierdo del jugador (espejo).
    const eje = pts[P.caderaIzq].clone().sub(pts[P.caderaDer]).normalize();
    const base = (x, y) => {
      const yy = y.clone().sub(x.clone().multiplyScalar(x.dot(y))).normalize();
      return new THREE.Matrix4().makeBasis(x, yy, new THREE.Vector3().crossVectors(x, yy));
    };
    const giro = new THREE.Quaternion().setFromRotationMatrix(
      base(eje, tronco).multiply(base(this.ejeCaderaReposo, ARRIBA).transpose()));
    const raiz = this.huesos.raiz;
    const qPadreRaiz = padreMundo("raiz");
    const qRaiz = giro.multiply(qPadreRaiz.clone().multiply(this.reposoLocal.raiz));
    mundo.raiz = qRaiz;
    raiz.quaternion.copy(qPadreRaiz.clone().invert().multiply(qRaiz));

    for (const n of ["cadera_izq", "cadera_der"]) fijar(n, null);
    fijar("columna", ve(P.caderaIzq, P.caderaDer, P.hombroIzq, P.hombroDer) ? tronco : null);
    for (const n of ["cabeza", "hombro_izq", "hombro_der"]) fijar(n, null);
    for (const [n, a, b] of SEGMENTOS.sort((x, y) => ORDEN.indexOf(x[0]) - ORDEN.indexOf(y[0]))) {
      fijar(n, ve(a, b) ? dir(a, b) : null);
    }

    // Apoya en el piso la pezuña más baja.
    this.grupo.position.y = 0;
    this.modelo.updateMatrixWorld(true);
    const piso = Math.min(...["pie_izq", "pie_der"].map((n) => this.huesos[n].getWorldPosition(this._v).y));
    this.grupo.position.y = this.altoPiso - piso;
    this.grupo.visible = true;
  }

  ocultar() { this.grupo.visible = false; }

  /** Brillo de color en la pierna (lado del jugador) que mide el ejercicio; color null lo quita. */
  resaltar(_articulacion, ladoJugador, color) {
    if (this.guia) return; // la guía conserva su color de holograma
    for (const [lado, m] of Object.entries(this.materialesPierna)) {
      m.userData.resalte = color && lado === ESPEJO[ladoJugador] ? color : null;
    }
  }

  /** Se llama en cada cuadro: combina el resalte del ejercicio con el brillo de la etapa. */
  animar(t) {
    if (this.guia) return;
    for (const m of Object.values(this.materialesPierna)) {
      const { resalte, etapa } = m.userData;
      if (resalte) {
        m.emissive.set(resalte);
        m.emissiveIntensity = 0.45;
      } else if (etapa === "en_forma") {
        m.emissive.set(0x7cff4f); // pulso verde: pierna en plena forma
        m.emissiveIntensity = 0.25 + 0.15 * Math.sin(t / 300);
      } else if (etapa === "fortaleciendose") {
        m.emissive.set(0xffe14d);
        m.emissiveIntensity = 0.18;
      } else {
        m.emissive.set(0x000000);
        m.emissiveIntensity = 0;
      }
    }
  }

  /**
   * Aspecto de cada pierna según su etapa (`ETAPAS`), o null si no hay datos (pierna normal).
   * @param {{izq?: string|null, der?: string|null}} etapas por lado del jugador
   */
  mostrarEtapas(etapas) {
    if (this.guia) return;
    for (const ladoJugador of ["izq", "der"]) {
      const m = ESPEJO[ladoJugador];
      const etapa = etapas[ladoJugador] ?? null;
      this.opcionales[`venda_completa_${m}`].visible = etapa === "vendada";
      this.opcionales[`venda_parcial_${m}`].visible = etapa === "venda_parcial";
      const mat = this.materialesPierna[m];
      // Vendada: pelaje apagado. Fortaleciéndose y en forma: el color vuelve con más vida.
      const apagado = { vendada: 0.45, venda_parcial: 0.25 }[etapa] ?? 0;
      mat.color.copy(mat.userData.colorBase).lerp(new THREE.Color(0x777777), apagado);
      mat.userData.etapa = etapa;
    }
  }
}
