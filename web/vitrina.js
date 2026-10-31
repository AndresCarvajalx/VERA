// Un personaje solo sobre un pedestal de neón, para las vistas previas de la selección y la
// demostración del manual. Quien la usa decide la pose de cada cuadro (función `pose`).
import * as THREE from "./vendor/three.module.min.js";
import { poseQuieta } from "./guia.js";
import { Toribara, cargarModelo } from "./toribara.js";

function token(nombre) {
  return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
}

export class Vitrina {
  /**
   * @param {HTMLElement} contenedor
   * @param {{pose?: (t: number) => {pts: THREE.Vector3[], sentado?: boolean, giro?: number}}} opciones
   */
  constructor(contenedor, { pose } = {}) {
    this.contenedor = contenedor;
    this.pose = pose ?? ((t) => ({ pts: poseQuieta(t) }));
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    contenedor.appendChild(this.renderer.domElement);
    this.escena = new THREE.Scene();
    this.camara = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
    this.camara.position.set(0, 1.05, 4.1);
    this.camara.lookAt(0, 0.86, 0);
    this.escena.add(new THREE.HemisphereLight(0xffffff, 0x3a1a7a, 1.8));
    const frente = new THREE.DirectionalLight(0xffffff, 1.5);
    frente.position.set(1, 2.5, 3);
    this.escena.add(frente);
    const contra = new THREE.PointLight(token("--rosa"), 5, 6, 1.6);
    contra.position.set(-1.5, 2, -1);
    this.escena.add(contra);

    const pedestal = new THREE.Mesh(new THREE.CircleGeometry(0.7, 48),
      new THREE.MeshStandardMaterial({ color: token("--piso"), roughness: 0.6, metalness: 0.2 }));
    pedestal.rotation.x = -Math.PI / 2;
    this.escena.add(pedestal);
    this.aro = new THREE.Mesh(new THREE.RingGeometry(0.66, 0.7, 64),
      new THREE.MeshBasicMaterial({ color: token("--cian"), transparent: true, opacity: 0.9 }));
    this.aro.rotation.x = -Math.PI / 2;
    this.aro.position.y = 0.003;
    this.escena.add(this.aro);

    this.silla = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1, 0.42),
      new THREE.MeshStandardMaterial({ color: token("--silla"), roughness: 0.7 }));
    this.silla.visible = false;
    this.personaje = null;
    this.clave = null;
    this._corriendo = false;
    new ResizeObserver(() => this._ajustar()).observe(contenedor);
  }

  /** Carga el personaje (modelos/<clave>.glb). Devuelve false si falla. */
  async poner(clave) {
    if (clave === this.clave) return true;
    this.clave = clave;
    try {
      const gltf = await cargarModelo(`modelos/${clave}.glb`);
      if (clave !== this.clave) return false;
      if (this.personaje) this.escena.remove(this.personaje.grupo);
      this.personaje = new Toribara(this.escena, gltf);
      // Asiento a la altura de la rodilla de cada personaje, como en la escena del juego.
      const asiento = this.personaje.alturaRodilla;
      this.silla.scale.y = asiento;
      this.silla.position.set(0, asiento / 2, -0.02);
      this.personaje.grupo.add(this.silla);
      return true;
    } catch (error) {
      console.warn(`No se pudo cargar el personaje ${clave}`, error);
      return false;
    }
  }

  /** Color del aro del pedestal (resalta la tarjeta elegida). */
  colorAro(nombre) { this.aro.material.color.set(token(nombre)); }

  activar(si) {
    if (si === this._corriendo) return;
    this._corriendo = si;
    if (si) this._ajustar();
    this.renderer.setAnimationLoop(si ? (t) => this._cuadro(t) : null);
  }

  _ajustar() {
    const { clientWidth: ancho, clientHeight: alto } = this.contenedor;
    if (!ancho || !alto) return;
    this.renderer.setSize(ancho, alto, false);
    this.camara.aspect = ancho / alto;
    this.camara.updateProjectionMatrix();
  }

  _cuadro(t) {
    if (this.personaje) {
      const { pts, sentado = false, giro = 0, resalte = null } = this.pose(t);
      this.personaje.grupo.rotation.y = giro;
      this.personaje.actualizar(pts);
      this.personaje.resaltar(null, resalte?.lado, resalte?.color ?? null);
      this.personaje.animar(t);
      this.silla.visible = sentado;
    }
    this.renderer.render(this.escena, this.camara);
  }
}
