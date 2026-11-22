// Efectos de la escena 3D que no dependen de complementos externos de Three.js:
// luz de entorno (reflejos suaves en los personajes), halos de neón y confeti.
import * as THREE from "./vendor/three.module.min.js";

/**
 * Mapa de entorno hecho con una "sala" de paneles de luz de colores: los materiales de los
 * personajes toman de ahí reflejos suaves y volumen, en vez de verse como plástico mate.
 * @param {THREE.WebGLRenderer} renderer
 * @param {string[]} colores de los paneles (los mismos del escenario)
 */
export function entornoLuminoso(renderer, colores) {
  const sala = new THREE.Scene();
  sala.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial({ color: 0x15102a, side: THREE.BackSide })));
  const panel = (color, intensidad, x, y, z, ancho, alto) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(ancho, alto),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensidad), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    sala.add(m);
  };
  panel("#ffffff", 3, 0, 4.5, 2, 5, 3); // luz principal arriba y de frente
  panel(colores[0], 2.2, -4.5, 1.5, -1, 2.5, 6); // contornos de color a los lados
  panel(colores[1], 2.2, 4.5, 1.5, -1, 2.5, 6);
  panel("#ffffff", 0.8, 0, 1, 4.8, 6, 2); // relleno suave desde la cámara
  const pmrem = new THREE.PMREMGenerator(renderer);
  const textura = pmrem.fromScene(sala, 0.04).texture;
  pmrem.dispose();
  sala.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  return textura;
}

/**
 * Halo de neón: una copia más gruesa y aditiva de la pieza, que simula el resplandor.
 * El halo copia el color de la pieza en cada cuadro con `actualizar`.
 */
export function halo(pieza, geometria, opacidad = 0.22) {
  const material = new THREE.MeshBasicMaterial({
    transparent: true, opacity: opacidad, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const malla = new THREE.Mesh(geometria, material);
  malla.position.copy(pieza.position);
  malla.rotation.copy(pieza.rotation);
  malla.userData = { pieza, base: opacidad };
  pieza.parent.add(malla);
  malla.actualizar = (factor = 1) => {
    material.color.copy(pieza.material.color);
    material.opacity = malla.userData.base * factor;
    malla.scale.y = pieza.scale.y;
    malla.visible = pieza.visible;
  };
  malla.actualizar();
  return malla;
}

const CONFETI = 260;
const GRAVEDAD = -3.2;

/** Confeti de papelitos que giran y caen. Un solo InstancedMesh para todos: barato de dibujar. */
export class Confeti {
  constructor(escena) {
    this.malla = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.045, 0.07),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true }), CONFETI);
    this.malla.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.malla.frustumCulled = false;
    this.malla.count = 0;
    escena.add(this.malla);
    this.trozos = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
  }

  /** Lanza `cantidad` papelitos desde `origen` (THREE.Vector3) con los `colores` dados. */
  lanzar(origen, colores, cantidad = 60, fuerza = 1) {
    for (let i = 0; i < cantidad; i++) {
      if (this.trozos.length >= CONFETI) this.trozos.shift();
      const angulo = Math.random() * Math.PI * 2;
      const abre = (0.6 + Math.random() * 1.2) * fuerza;
      this.trozos.push({
        p: origen.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.2)),
        v: new THREE.Vector3(Math.cos(angulo) * abre, (2.2 + Math.random() * 1.6) * fuerza, Math.sin(angulo) * abre * 0.5),
        giro: new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9),
        color: new THREE.Color(colores[i % colores.length]),
        vida: 0, duracion: 1.8 + Math.random() * 1.2,
      });
    }
  }

  animar(dt) {
    this.trozos = this.trozos.filter((t) => (t.vida += dt) < t.duracion);
    for (const [i, t] of this.trozos.entries()) {
      t.v.y += GRAVEDAD * dt;
      t.v.multiplyScalar(1 - 1.4 * dt); // el aire los frena: caen planeando
      t.p.addScaledVector(t.v, dt);
      this._e.set(t.giro.x * t.vida, t.giro.y * t.vida, t.giro.z * t.vida);
      const tamano = Math.min(1, (t.duracion - t.vida) * 2.5); // se achican al final
      this._m.compose(t.p, this._q.setFromEuler(this._e), this._s.setScalar(tamano));
      this.malla.setMatrixAt(i, this._m);
      this.malla.setColorAt(i, t.color);
    }
    this.malla.count = this.trozos.length;
    this.malla.instanceMatrix.needsUpdate = true;
    if (this.malla.instanceColor) this.malla.instanceColor.needsUpdate = true;
  }
}

/** Onda de luz que se expande desde los pies (al lograr una repetición). */
export class Ondas {
  constructor(escena) {
    this.escena = escena;
    this.activas = [];
  }

  lanzar(x, color) {
    const malla = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.56, 64),
      new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    malla.rotation.x = -Math.PI / 2;
    malla.position.set(x, 0.01, 0);
    this.escena.add(malla);
    this.activas.push({ malla, vida: 0 });
  }

  animar(dt) {
    this.activas = this.activas.filter((o) => {
      o.vida += dt;
      const avance = o.vida / 0.9;
      if (avance >= 1) {
        this.escena.remove(o.malla);
        o.malla.geometry.dispose();
        o.malla.material.dispose();
        return false;
      }
      o.malla.scale.setScalar(1 + avance * 2.4);
      o.malla.material.opacity = 1 - avance;
      return true;
    });
  }
}
