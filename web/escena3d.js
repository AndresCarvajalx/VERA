// Escena 3D del juego: el avatar del jugador (copia sus movimientos) y el avatar guía
// (repite el ejercicio de referencia) uno al lado del otro sobre un piso.
import * as THREE from "./vendor/three.module.min.js";
import { Avatar, esqueletoEstable } from "./avatar.js";
import { Confeti, Ondas, entornoLuminoso, halo } from "./efectos3d.js";
import { Escenario } from "./escenario.js";
import { cicloGuia, poseGuia, poseSaludo } from "./guia.js";
import { Toribara, cargarModelo } from "./toribara.js";

const SEPARACION = 0.75; // metros desde el centro a cada avatar

// Color de una variable del tema ya resuelto a rgb(): en el tema profesional las variables son
// pares light-dark() y Three.js no los entiende. Se resuelve dentro del escenario, que es siempre oscuro.
const resueltos = new Map();
let sonda = null;
function token(nombre) {
  if (!resueltos.has(nombre)) {
    sonda.style.color = `var(${nombre})`;
    resueltos.set(nombre, getComputedStyle(sonda).color);
  }
  return resueltos.get(nombre);
}

export class Escena3D {
  constructor(contenedor) {
    this.contenedor = contenedor;
    sonda = contenedor.appendChild(Object.assign(document.createElement("span"), { hidden: true }));
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    contenedor.appendChild(this.renderer.domElement);

    this.escena = new THREE.Scene();
    this.camara = new THREE.PerspectiveCamera(35, 1, 0.1, 90);
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
    piso.receiveShadow = true;
    this.escena.add(piso);
    this.piso = piso;
    this.aros = [[2.55, "--rosa"], [1.6, "--cian"]].map(([radio, variable]) => {
      const aro = new THREE.Mesh(
        new THREE.RingGeometry(radio - 0.04, radio, 96),
        new THREE.MeshBasicMaterial({ color: token(variable), transparent: true, opacity: 0.85 }),
      );
      aro.rotation.x = -Math.PI / 2;
      aro.position.y = 0.002;
      aro.userData.variable = variable;
      this.escena.add(aro);
      return aro;
    });
    this.escenario = new Escenario(this.escena, this.renderer, token, SEPARACION);
    this.halosAros = this.aros.map((aro, i) => halo(aro, new THREE.RingGeometry(i ? 1.5 : 2.45, i ? 1.7 : 2.65, 96), 0.2));
    this.escena.environment = entornoLuminoso(this.renderer, [token("--guia"), token("--avatar")]);
    this.confeti = new Confeti(this.escena);
    this.ondas = new Ondas(this.escena);
    this.sobrio = false;
    this._festejo = null; // {hasta, brazo}: la guía deja el ejercicio y celebra un momento
    this._anterior = performance.now();

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
    this.listo = this.cambiarPersonaje("persona"); // personaje por defecto; la página lo cambia según el jugador

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

  /** El tema cambió: se vuelven a leer los colores. `sobrio` = tema profesional. */
  cambiarTema(sobrio) {
    this.sobrio = sobrio;
    resueltos.clear();
    this.piso.material.color.set(sobrio ? "#1a2230" : token("--piso"));
    for (const aro of this.aros) {
      aro.material.color.set(token(aro.userData.variable));
      aro.material.opacity = sobrio ? 0.5 : 0.85;
    }
    for (const h of this.halosAros) h.actualizar(sobrio ? 0 : 1);
    this.escenario.colorear(sobrio);
  }

  /** Lugar del escenario: "ciudad", "playa" o "espacio" (se desbloquean jugando, ver prueba.js). */
  cambiarAmbiente(nombre) {
    this.escenario.ambiente(nombre);
  }

  /** Destello del decorado al terminar una repetición ("perfecto", "bien", "casi", "mal") o la serie. */
  celebrar(calidad) {
    const variable = { perfecto: "--ok", bien: "--resalte", serie: "--ok" }[calidad];
    if (!variable) return;
    this.escenario.destello(token(variable), calidad === "bien" ? 0.6 : 1);
    // La guía festeja: saluda con el brazo del lado de afuera (un momento más largo al terminar la serie).
    this._festejo = { hasta: performance.now() + (calidad === "serie" ? 2600 : 1300), brazo: -1 };
    if (this.sobrio) return; // el tema profesional no lleva confeti
    const x = this.jugador.grupo.position.x;
    this.ondas.lanzar(x, token(variable));
    const colores = [token("--rosa"), token("--cian"), token("--amarillo"), token("--lima"), "#ffffff"];
    if (calidad === "perfecto") this.confeti.lanzar(new THREE.Vector3(x, 1.9, 0), colores, 45, 0.8);
    if (calidad === "serie") {
      this.confeti.lanzar(new THREE.Vector3(x, 2.1, 0), colores, 110, 1.2);
      this.confeti.lanzar(new THREE.Vector3(-x, 2.1, 0), colores, 110, 1.2);
    }
  }

  /** Lleva el mismo lienzo a otro contenedor (sesión guiada ↔ panel del fisioterapeuta). */
  moverA(contenedor) {
    if (contenedor === this.contenedor) return;
    this._observador.unobserve(this.contenedor);
    this.contenedor = contenedor;
    contenedor.append(this.renderer.domElement, sonda);
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
   * "persona", "mujer", "toribara", "conejibara"). Si el modelo no carga, se conservan los personajes actuales
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
    const ahora = performance.now();
    const dt = Math.min(0.05, (ahora - this._anterior) / 1000);
    this._anterior = ahora;
    const ej = this.ejercicioGuia;
    const { grados, fase } = cicloGuia(ahora - this._inicio, ej.objetivo, ej.tiempo_sostenido_ms);
    const festeja = this._festejo && ahora < this._festejo.hasta;
    const { pts, sentado } = festeja ? { pts: poseSaludo(ahora, this._festejo.brazo), sentado: false } : poseGuia(ej, grados);
    this.guia.actualizar(pts);
    this.guia.resaltar(ej.articulacion, ej.lado, festeja || fase === "sostén" ? token("--ok") : token("--resalte"));
    this.silla.visible = sentado;
    this.confeti.animar(dt);
    this.ondas.animar(dt);
    this.jugador.animar?.(performance.now());
    this.guia.animar?.(performance.now());
    this.escenario.animar(performance.now());
    this.faseGuia = ej.objetivo === 0 ? "quieta" : fase;
    this.renderer.render(this.escena, this.camara);
  }
}
