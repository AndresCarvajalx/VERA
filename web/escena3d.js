// Escena 3D del juego: el avatar del jugador (copia sus movimientos) y el avatar guía
// (repite el ejercicio de referencia) uno al lado del otro sobre un piso.
import * as THREE from "./vendor/three.module.min.js";
import { Avatar, esqueletoEstable } from "./avatar.js";
import { cicloGuia, poseGuia } from "./guia.js";

const SEPARACION = 0.75; // metros desde el centro a cada avatar

function token(nombre) {
  return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
}

export class Escena3D {
  constructor(contenedor) {
    this.contenedor = contenedor;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    contenedor.appendChild(this.renderer.domElement);

    this.escena = new THREE.Scene();
    this.camara = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
    this.camara.position.set(0, 1.15, 4.3);
    this.camara.lookAt(0, 0.85, 0);

    this.escena.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sol = new THREE.DirectionalLight(0xffffff, 1.8);
    sol.position.set(1.5, 3, 2.5);
    this.escena.add(sol);

    const piso = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 48),
      new THREE.MeshStandardMaterial({ color: token("--borde"), roughness: 1 }),
    );
    piso.rotation.x = -Math.PI / 2;
    this.escena.add(piso);

    // El jugador a la derecha de la pantalla y la guía, translúcida, a la izquierda.
    this.jugador = new Avatar(this.escena, { color: token("--avatar") });
    this.jugador.grupo.position.x = SEPARACION;
    this.jugador.ocultar();
    this.guia = new Avatar(this.escena, { color: token("--guia"), opacidad: 0.75 });
    this.guia.grupo.position.x = -SEPARACION;

    this.silla = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.46, 0.42),
      new THREE.MeshStandardMaterial({ color: token("--suave"), roughness: 0.9 }),
    );
    this.silla.position.set(0, 0.23, 0.05);
    this.guia.grupo.add(this.silla); // gira junto con la guía

    this.ejercicioGuia = { articulacion: "rodilla", lado: "der", sentido: 1, objetivo: 20, tiempo_sostenido_ms: 500 };
    this.faseGuia = "";
    this._inicio = performance.now();
    new ResizeObserver(() => this._ajustarTamano()).observe(contenedor);
    this._ajustarTamano();
    this.renderer.setAnimationLoop(() => this._cuadro());
  }

  _ajustarTamano() {
    const { clientWidth: ancho, clientHeight: alto } = this.contenedor;
    if (!ancho || !alto) return;
    this.renderer.setSize(ancho, alto, false);
    this.camara.aspect = ancho / alto;
    this.camara.updateProjectionMatrix();
  }

  /** Ejercicio que demuestra la guía: el mismo que está configurado o en curso. */
  mostrarEjercicio(ejercicio) {
    this.ejercicioGuia = { ...this.ejercicioGuia, ...ejercicio };
    // Los ejercicios ocurren en el plano sagital, que de frente casi no se ve: la guía se
    // gira a tres cuartos mostrando el lado de la pierna que trabaja.
    this.guia.grupo.rotation.y = this.ejercicioGuia.lado === "der" ? -0.75 : 0.75;
  }

  /** Mensaje de fotograma del servicio de visión. */
  actualizarJugador(msg) {
    if (!msg.mundo?.length) { this.jugador.ocultar(); return; }
    const { pts, visibles } = esqueletoEstable(msg);
    this.jugador.actualizar(pts, visibles);
    const rep = msg.rep;
    const ej = this.ejercicioGuia;
    if (msg.calibracion) {
      this.jugador.resaltar(ej.articulacion, ej.lado, msg.calibracion.en_intento ? token("--acento") : token("--resalte"));
      return;
    }
    if (!rep) { this.jugador.resaltar(ej.articulacion, ej.lado, null); return; }
    const color = rep.estado === "en_objetivo" || rep.estado === "bajando" ? token("--ok")
      : rep.estado === "subiendo" ? token("--acento") : token("--resalte");
    this.jugador.resaltar(ej.articulacion, ej.lado, color);
  }

  _cuadro() {
    const ej = this.ejercicioGuia;
    const { grados, fase } = cicloGuia(performance.now() - this._inicio, ej.objetivo, ej.tiempo_sostenido_ms);
    const { pts, sentado } = poseGuia(ej, grados);
    this.guia.actualizar(pts);
    this.guia.resaltar(ej.articulacion, ej.lado, fase === "sostén" ? token("--ok") : token("--resalte"));
    this.silla.visible = sentado;
    this.faseGuia = ej.objetivo === 0 ? "quieta" : fase;
    this.renderer.render(this.escena, this.camara);
  }
}
