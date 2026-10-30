// Avatar 3D construido con cilindros (huesos) y esferas (articulaciones) entre los puntos
// de MediaPipe: cada hueso se coloca y orienta en cada fotograma a partir de sus dos
// puntos extremos ("mapeo directo de los puntos clave a los huesos del esqueleto").
import * as THREE from "./vendor/three.module.min.js";

// Índices del modelo de 33 puntos de MediaPipe Pose.
export const P = {
  orejaIzq: 7, orejaDer: 8,
  hombroIzq: 11, hombroDer: 12, codoIzq: 13, codoDer: 14, munecaIzq: 15, munecaDer: 16,
  caderaIzq: 23, caderaDer: 24, rodillaIzq: 25, rodillaDer: 26,
  tobilloIzq: 27, tobilloDer: 28, talonIzq: 29, talonDer: 30, pieIzq: 31, pieDer: 32,
};

// [desde, hasta, radio en metros, nombre]
const HUESOS = [
  [P.hombroIzq, P.codoIzq, 0.045, "brazo_izq"], [P.codoIzq, P.munecaIzq, 0.04, "antebrazo_izq"],
  [P.hombroDer, P.codoDer, 0.045, "brazo_der"], [P.codoDer, P.munecaDer, 0.04, "antebrazo_der"],
  [P.caderaIzq, P.rodillaIzq, 0.065, "muslo_izq"], [P.rodillaIzq, P.tobilloIzq, 0.05, "pierna_izq"],
  [P.caderaDer, P.rodillaDer, 0.065, "muslo_der"], [P.rodillaDer, P.tobilloDer, 0.05, "pierna_der"],
  [P.talonIzq, P.pieIzq, 0.035, "pie_izq"], [P.tobilloIzq, P.talonIzq, 0.035, "talon_izq"],
  [P.talonDer, P.pieDer, 0.035, "pie_der"], [P.tobilloDer, P.talonDer, 0.035, "talon_der"],
  [P.hombroIzq, P.hombroDer, 0.05, "hombros"], [P.caderaIzq, P.caderaDer, 0.07, "pelvis"],
];

// Huesos que se resaltan según la articulación que mide el ejercicio.
export const HUESOS_POR_ARTICULACION = {
  cadera: ["muslo"],
  rodilla: ["muslo", "pierna"],
  tobillo: ["pierna", "pie", "talon"],
};

const ARRIBA = new THREE.Vector3(0, 1, 0);

export class Avatar {
  /**
   * @param {THREE.Scene} escena
   * @param {{color: string, opacidad?: number}} opciones
   */
  constructor(escena, { color, opacidad = 1 }) {
    this.grupo = new THREE.Group();
    escena.add(this.grupo);
    this.colorBase = new THREE.Color(color);
    this.opacidad = opacidad;
    // Transparente siempre: las partes que la cámara no ve se dibujan translúcidas.
    // Un leve brillo propio del mismo color hace que el avatar resalte sobre el escenario oscuro.
    const material = () => new THREE.MeshStandardMaterial({
      color: this.colorBase, emissive: this.colorBase, emissiveIntensity: 0.18,
      roughness: 0.4, metalness: 0.1, transparent: true, opacity: opacidad,
    });
    const cilindro = new THREE.CylinderGeometry(1, 1, 1, 16);
    const esfera = new THREE.SphereGeometry(1, 16, 12);

    this.huesos = HUESOS.map(([a, b, r, nombre]) => {
      const malla = new THREE.Mesh(cilindro, material());
      malla.userData = { a, b, r, nombre };
      this.grupo.add(malla);
      return malla;
    });
    // Una esfera en cada extremo de hueso redondea las uniones.
    const puntos = [...new Set(HUESOS.flatMap(([a, b]) => [a, b]))];
    this.articulaciones = puntos.map((i) => {
      const r = Math.max(...HUESOS.filter(([a, b]) => a === i || b === i).map(([, , r]) => r));
      const malla = new THREE.Mesh(esfera, material());
      malla.scale.setScalar(r * 1.1);
      malla.userData = { i };
      this.grupo.add(malla);
      return malla;
    });
    this.torso = new THREE.Mesh(cilindro, material());
    this.cabeza = new THREE.Mesh(esfera, material());
    this.cabeza.scale.setScalar(0.11);
    this.grupo.add(this.torso, this.cabeza);
    this._v = new THREE.Vector3();
  }

  /**
   * @param {THREE.Vector3[]} pts 33 puntos ya en coordenadas de la escena (y hacia arriba, metros).
   * @param {boolean[]} [visibles] por punto; los huesos con un extremo no visible quedan translúcidos
   *   para no presentar como real una posición que el modelo solo está suponiendo.
   */
  actualizar(pts, visibles) {
    const opacidad = (...indices) => (!visibles || indices.every((i) => visibles[i]) ? this.opacidad : 0.18);
    for (const malla of this.huesos) {
      const { a, b, r } = malla.userData;
      colocarCilindro(malla, pts[a], pts[b], r, this._v);
      malla.material.opacity = opacidad(a, b);
    }
    for (const malla of this.articulaciones) {
      malla.position.copy(pts[malla.userData.i]);
      malla.material.opacity = opacidad(malla.userData.i);
    }
    // Tronco: cilindro ancho entre el centro de los hombros y el de la cadera.
    const hombros = pts[P.hombroIzq].clone().add(pts[P.hombroDer]).multiplyScalar(0.5);
    const cadera = pts[P.caderaIzq].clone().add(pts[P.caderaDer]).multiplyScalar(0.5);
    colocarCilindro(this.torso, hombros, cadera, 0.12, this._v);
    this.torso.material.opacity = opacidad(P.hombroIzq, P.hombroDer, P.caderaIzq, P.caderaDer);
    this.cabeza.position.addVectors(pts[P.orejaIzq], pts[P.orejaDer]).multiplyScalar(0.5);
    this.grupo.visible = true;
  }

  ocultar() { this.grupo.visible = false; }

  /** Colorea los huesos de una articulación y lado (p. ej. rodilla der) o los restaura con color = null. */
  resaltar(articulacion, lado, color) {
    const prefijos = (HUESOS_POR_ARTICULACION[articulacion] ?? []).map((p) => `${p}_${lado}`);
    for (const malla of this.huesos) {
      const activo = color && prefijos.includes(malla.userData.nombre);
      malla.material.color.set(activo ? color : this.colorBase);
      malla.material.emissive.set(activo ? color : this.colorBase);
    }
  }
}

function colocarCilindro(malla, a, b, radio, tmp) {
  tmp.subVectors(b, a);
  const largo = tmp.length();
  if (largo < 1e-4) { malla.visible = false; return; }
  malla.visible = true;
  malla.position.addVectors(a, b).multiplyScalar(0.5);
  malla.scale.set(radio, largo, radio);
  malla.quaternion.setFromUnitVectors(ARRIBA, tmp.divideScalar(largo));
}

const UMBRAL_VISIBILIDAD = 0.5;

// Largos fijos de los huesos (m), iguales a los del avatar guía para poder compararlos.
// Los largos que entrega MediaPipe en 3D variaban ±25 % entre fotogramas (medido), lo que
// estiraba y encogía el avatar; con largos fijos solo cambia la orientación de cada hueso.
const LARGOS = {
  cadera_media: 0.1, tronco: 0.5, hombro_medio: 0.18, cuello: 0.18,
  brazo: 0.28, antebrazo: 0.26, muslo: 0.43, pierna: 0.42, talon: 0.08, pie: 0.19,
};

// Cadena de huesos desde la raíz (centro de la cadera): [padre, hijo, largo].
const CADENA = ["Izq", "Der"].flatMap((L) => [
  [P[`cadera${L}`], P[`rodilla${L}`], LARGOS.muslo],
  [P[`rodilla${L}`], P[`tobillo${L}`], LARGOS.pierna],
  [P[`tobillo${L}`], P[`talon${L}`], LARGOS.talon],
  [P[`talon${L}`], P[`pie${L}`], LARGOS.pie],
  [P[`hombro${L}`], P[`codo${L}`], LARGOS.brazo],
  [P[`codo${L}`], P[`muneca${L}`], LARGOS.antebrazo],
]);

/**
 * Construye el esqueleto del jugador en la escena a partir de un mensaje de fotograma.
 *
 * - La dirección de cada hueso en el plano de la pantalla sale de los puntos 2D de la imagen,
 *   los mismos con que se miden los ángulos: lo que se ve en el avatar coincide con lo medido.
 * - La profundidad (z) sale de los puntos 3D de MediaPipe, que solo aportan el componente
 *   hacia la cámara.
 * - Los largos son fijos (LARGOS) y la vista es en espejo (x invertida, y hacia arriba).
 * Devuelve los 33 puntos y la visibilidad de cada uno.
 */
export function esqueletoEstable(msg) {
  const [ancho, alto] = msg.imagen;
  // Cada punto: x, y en pixeles de la imagen y z (profundidad, m) del modelo 3D.
  const punto = (i) => ({ x: msg.landmarks[i][0] * ancho, y: msg.landmarks[i][1] * alto, z: msg.mundo[i][2] });
  const medio = (a, b) => {
    const pa = punto(a), pb = punto(b);
    return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 };
  };
  const hombros = medio(P.hombroIzq, P.hombroDer);
  const caderas = medio(P.caderaIzq, P.caderaDer);

  // Escala pixeles → metros con el tronco, para que x, y sean comparables con la z en metros.
  const mw = (i) => msg.mundo[i];
  const troncoMundo = Math.hypot(
    ...[0, 1, 2].map((k) => (mw(P.hombroIzq)[k] + mw(P.hombroDer)[k] - mw(P.caderaIzq)[k] - mw(P.caderaDer)[k]) / 2));
  const troncoImg = Math.hypot(hombros.x - caderas.x, hombros.y - caderas.y);
  const escala = troncoImg > 1 ? troncoMundo / troncoImg : 0.002;

  // Dirección unitaria de pa hacia pb en la escena (espejo en x, y hacia arriba, z hacia la cámara).
  const direccion = (pa, pb) =>
    new THREE.Vector3(-(pb.x - pa.x) * escala, -(pb.y - pa.y) * escala, -(pb.z - pa.z)).normalize();

  const pts = Array.from({ length: 33 }, () => new THREE.Vector3());
  const raiz = new THREE.Vector3(0, 1, 0);
  const lateral = direccion(punto(P.caderaIzq), punto(P.caderaDer)); // hacia la cadera derecha
  pts[P.caderaIzq].copy(raiz).addScaledVector(lateral, -LARGOS.cadera_media);
  pts[P.caderaDer].copy(raiz).addScaledVector(lateral, LARGOS.cadera_media);

  const dirTronco = direccion(caderas, hombros);
  const centroHombros = raiz.clone().addScaledVector(dirTronco, LARGOS.tronco);
  const ejeHombros = direccion(punto(P.hombroIzq), punto(P.hombroDer));
  pts[P.hombroIzq].copy(centroHombros).addScaledVector(ejeHombros, -LARGOS.hombro_medio);
  pts[P.hombroDer].copy(centroHombros).addScaledVector(ejeHombros, LARGOS.hombro_medio);
  // Cabeza sobre los hombros en la dirección del tronco (la posición de las orejas es ruidosa).
  const cabeza = centroHombros.clone().addScaledVector(dirTronco, LARGOS.cuello);
  pts[P.orejaIzq].copy(cabeza);
  pts[P.orejaDer].copy(cabeza);

  for (const [padre, hijo, largo] of CADENA) {
    pts[hijo].copy(pts[padre]).addScaledVector(direccion(punto(padre), punto(hijo)), largo);
  }

  const pies = [P.talonIzq, P.talonDer, P.pieIzq, P.pieDer, P.tobilloIzq, P.tobilloDer];
  const piso = Math.min(...pies.map((i) => pts[i].y));
  for (const p of pts) p.y -= piso;
  return { pts, visibles: msg.landmarks.map((l) => l[3] >= UMBRAL_VISIBILIDAD) };
}
