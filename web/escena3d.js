// Escena 3D del juego: el avatar del jugador (copia sus movimientos) y el avatar guía
// (repite el ejercicio de referencia) uno al lado del otro sobre un piso.
import * as THREE from "./vendor/three.module.min.js";
import { Avatar, esqueletoEstable } from "./avatar.js";
import { cicloGuia, poseGuia } from "./guia.js";
import { Toribara, cargarModelo } from "./toribara.js";

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

    // Iluminación de escenario: luz base suave y dos focos de color (cian y rosa) a los lados.
    this.escena.add(new THREE.HemisphereLight(0xffffff, 0x3a1a7a, 1.4));
    const frente = new THREE.DirectionalLight(0xffffff, 1.4);
    frente.position.set(0, 2.5, 3);
    this.escena.add(frente);
    for (const [color, x] of [[token("--guia"), -2.2], [token("--avatar"), 2.2]]) {
      const foco = new THREE.PointLight(color, 6, 7, 1.6);
      foco.position.set(x, 2.4, 1.2);
      this.escena.add(foco);
    }

    // Piso de escenario con un aro de neón.
    const piso = new THREE.Mesh(
      new THREE.CircleGeometry(2.6, 64),
      new THREE.MeshStandardMaterial({ color: token("--piso"), roughness: 0.6, metalness: 0.2 }),
    );
    piso.rotation.x = -Math.PI / 2;
    this.escena.add(piso);
    for (const [radio, color] of [[2.55, token("--rosa")], [1.6, token("--cian")]]) {
      const aro = new THREE.Mesh(
        new THREE.RingGeometry(radio - 0.04, radio, 96),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      );
      aro.rotation.x = -Math.PI / 2;
      aro.position.y = 0.002;
      this.escena.add(aro);
    }

    // El jugador a la derecha de la pantalla y la guía, translúcida, a la izquierda.
    this.jugador = new Avatar(this.escena, { color: token("--avatar") });
    this.jugador.grupo.position.x = SEPARACION;
    this.jugador.ocultar();
    this.guia = new Avatar(this.escena, { color: token("--guia"), opacidad: 0.75 });
    this.guia.grupo.position.x = -SEPARACION;

    this.silla = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.46, 0.42),
      new THREE.MeshStandardMaterial({ color: token("--silla"), roughness: 0.7 }),
    );
    this.silla.position.set(0, 0.23, 0.05);
    this.guia.grupo.add(this.silla); // gira junto con la guía
    this.etapas = {};
    this.personaje = null;
    this._pedido = 0; // descarta cargas viejas si se elige otro personaje antes de que termine
    this.cambiarPersonaje("persona"); // personaje por defecto; la página lo cambia según el jugador

    this.ejercicioGuia = { articulacion: "rodilla", lado: "der", sentido: 1, objetivo: 20, tiempo_sostenido_ms: 500 };
    this.faseGuia = "";
    this._inicio = performance.now();
    this._observador = new ResizeObserver(() => this._ajustarTamano());
    this._observador.observe(contenedor);
    this._ajustarTamano();
  }

  /**
   * Cámara más lejana para la sesión guiada: el escenario ocupa toda la pantalla y arriba va la
   * tarjeta de instrucciones, así que los personajes deben quedar más chicos y más abajo.
   */
  camaraAmplia(si) {
    if (si) { this.camara.position.set(0, 1.25, 5.6); this.camara.lookAt(0, 1.0, 0); }
    else { this.camara.position.set(0, 1.15, 4.3); this.camara.lookAt(0, 0.85, 0); }
  }

  /** Lleva el mismo lienzo a otro contenedor (sesión guiada ↔ panel del fisioterapeuta). */
  moverA(contenedor) {
    if (contenedor === this.contenedor) return;
    this._observador.unobserve(this.contenedor);
    this.contenedor = contenedor;
    contenedor.appendChild(this.renderer.domElement);
    this._observador.observe(contenedor);
    this._ajustarTamano();
  }

  /** Dibuja solo mientras la pantalla del juego está a la vista (las demás tienen sus propias escenas). */
  activar(si) {
    if (si) this._ajustarTamano();
    this.renderer.setAnimationLoop(si ? () => this._cuadro() : null);
  }

  /**
   * Pone al jugador y a la guía con el personaje elegido (modelado/generar_personajes.py:
   * "persona", "toribara", "conejibara"). Si el modelo no carga, se conservan los personajes actuales
   * (al principio, los avatares de cilindros). Devuelve true si el cambio se hizo.
   */
  async cambiarPersonaje(clave) {
    if (clave === this.personaje) return true;
    const pedido = ++this._pedido;
    try {
      const url = `modelos/${clave}.glb`;
      const [modeloJugador, modeloGuia] = await Promise.all([cargarModelo(url), cargarModelo(url)]);
      if (pedido !== this._pedido) return false; // mientras cargaba se eligió otro
      const jugador = new Toribara(this.escena, modeloJugador);
      const guia = new Toribara(this.escena, modeloGuia, { guia: true, color: token("--guia") });
      jugador.grupo.position.x = SEPARACION;
      guia.grupo.position.x = -SEPARACION;
      guia.grupo.rotation.y = this.guia.grupo.rotation.y;
      // La silla de la guía se ajusta a la altura de la rodilla de cada personaje (asiento ≈ rodilla).
      const asiento = guia.alturaRodilla;
      this.silla.scale.y = asiento / 0.46;
      this.silla.position.set(0, asiento / 2, -0.02);
      guia.grupo.add(this.silla);
      jugador.grupo.visible = this.jugador.grupo.visible;
      jugador.mostrarEtapas(this.etapas);
      this.escena.remove(this.jugador.grupo, this.guia.grupo);
      [this.jugador, this.guia, this.personaje] = [jugador, guia, clave];
      return true;
    } catch (error) {
      console.warn(`No se pudo cargar el personaje ${clave}; se conserva el actual.`, error);
      return false;
    }
  }

  /** Etapa de cada pierna del jugador ({izq, der}: "vendada", "venda_parcial", ... o null). */
  mostrarEtapas(etapas) {
    this.etapas = etapas;
    this.jugador.mostrarEtapas?.(etapas);
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
    this.jugador.animar?.(performance.now());
    this.faseGuia = ej.objetivo === 0 ? "quieta" : fase;
    this.renderer.render(this.escena, this.camara);
  }
}
