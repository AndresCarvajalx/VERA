// Decorado del juego alrededor del jugador y la guía: piso con rejilla, plataformas, barras de luz
// al fondo, un arco, focos y partículas. Antes solo había un disco y dos aros, y se veía vacío.
//
// Los colores salen de las variables del tema (`colorear`), así que el tema profesional obtiene el
// mismo decorado en su versión sobria: sin partículas ni focos, y con las luces quietas.
import * as THREE from "./vendor/three.module.min.js";
import { halo } from "./efectos3d.js";

const BARRAS = 17;
const RADIO_FONDO = 4.4;
const PARTICULAS = 140;

/** Textura que se desvanece del centro hacia afuera: el piso se funde con el fondo de la página. */
function desvanecido() {
  const lienzo = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
  const ctx = lienzo.getContext("2d");
  const degradado = ctx.createRadialGradient(128, 128, 30, 128, 128, 128);
  degradado.addColorStop(0, "#fff");
  degradado.addColorStop(0.45, "#bbb");
  degradado.addColorStop(1, "#000");
  ctx.fillStyle = degradado;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(lienzo);
}

/** Degradado vertical para el cielo (de arriba hacia el horizonte). */
function cielo(colores) {
  const lienzo = Object.assign(document.createElement("canvas"), { width: 4, height: 256 });
  const ctx = lienzo.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  colores.forEach((c, i) => g.addColorStop([0, 0.45, 0.62, 0.7][i], c));
  g.addColorStop(1, colores.at(-1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const textura = new THREE.CanvasTexture(lienzo);
  textura.colorSpace = THREE.SRGBColorSpace;
  return textura;
}

/** Fachada oscura con ventanas: unas encendidas de colores, la mayoría apagadas. */
function texturaVentanas() {
  const lienzo = Object.assign(document.createElement("canvas"), { width: 64, height: 64 });
  const ctx = lienzo.getContext("2d");
  ctx.fillStyle = "#0b0418";
  ctx.fillRect(0, 0, 64, 64);
  const colores = ["#ffe14d", "#00e5ff", "#ff2e97", "#c9bbff"];
  for (let y = 4; y < 64; y += 10) {
    for (let x = 4; x < 64; x += 10) {
      if (Math.random() < 0.28) {
        ctx.fillStyle = colores[Math.floor(Math.random() * colores.length)];
        ctx.globalAlpha = 0.5 + Math.random() * 0.5;
        ctx.fillRect(x, y, 5, 6);
      }
    }
  }
  const textura = new THREE.CanvasTexture(lienzo);
  textura.wrapS = textura.wrapT = THREE.RepeatWrapping;
  textura.colorSpace = THREE.SRGBColorSpace;
  return textura;
}

export class Escenario {
  /**
   * @param {THREE.Scene} escena
   * @param {THREE.WebGLRenderer} renderer
   * @param {(nombre: string) => string} token color de una variable del tema, ya resuelto
   * @param {number} separacion distancia del centro a cada personaje (la guía a la izquierda)
   */
  constructor(escena, renderer, token, separacion) {
    this.token = token;
    this.escena = escena;
    this.grupo = new THREE.Group();
    escena.add(this.grupo);
    this._pulso = 0; // destello al lograr una repetición; se apaga solo
    this._colorPulso = new THREE.Color("#fff");

    // Sombras: una luz alta y de frente proyecta a los personajes sobre el piso.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const sol = new THREE.DirectionalLight(0xffffff, 0.9);
    sol.position.set(1.2, 5.5, 3.2);
    sol.castShadow = true;
    sol.shadow.mapSize.set(1024, 1024);
    Object.assign(sol.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 12 });
    sol.shadow.bias = -0.0015;
    sol.shadow.radius = 4;
    this.grupo.add(sol);
    // Luces de contorno desde atrás: separan a los personajes del fondo.
    this.contornos = [-1, 1].map((lado) => {
      const luz = new THREE.DirectionalLight(0xffffff, 1.1);
      luz.position.set(lado * 3, 2.2, -3.5);
      this.grupo.add(luz);
      return luz;
    });

    // Piso amplio que se desvanece, con rejilla de anillos y radios.
    this.pisoMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25, transparent: true, alphaMap: desvanecido() });
    const piso = new THREE.Mesh(new THREE.CircleGeometry(8, 64), this.pisoMaterial);
    piso.rotation.x = -Math.PI / 2;
    piso.position.y = -0.004;
    piso.receiveShadow = true;
    this.grupo.add(piso);
    this.rejillaMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.22 });
    const puntos = [];
    for (let radio = 3.4; radio <= 7; radio += 0.9) {
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2, b = ((i + 1) / 96) * Math.PI * 2;
        puntos.push(Math.cos(a) * radio, 0, Math.sin(a) * radio, Math.cos(b) * radio, 0, Math.sin(b) * radio);
      }
    }
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      puntos.push(Math.cos(a) * 2.7, 0, Math.sin(a) * 2.7, Math.cos(a) * 7, 0, Math.sin(a) * 7);
    }
    const rejilla = new THREE.LineSegments(new THREE.BufferGeometry(), this.rejillaMaterial);
    rejilla.geometry.setAttribute("position", new THREE.Float32BufferAttribute(puntos, 3));
    rejilla.position.y = 0.003;
    this.grupo.add(rejilla);

    // Una plataforma bajo cada personaje, con el borde de su color, y un foco suave desde arriba.
    this.plataformas = [-1, 1].map((lado) => {
      const disco = new THREE.Mesh(new THREE.CircleGeometry(0.62, 48),
        new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3, transparent: true, opacity: 0.55 }));
      const borde = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.66, 64), new THREE.MeshBasicMaterial({ transparent: true }));
      const foco = new THREE.Mesh(new THREE.ConeGeometry(0.85, 3.4, 40, 1, true),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      for (const plano of [disco, borde]) {
        plano.rotation.x = -Math.PI / 2;
        plano.position.set(lado * separacion, plano === disco ? 0.004 : 0.006, 0);
      }
      disco.receiveShadow = true;
      foco.position.set(lado * separacion, 1.7, 0);
      this.grupo.add(disco, borde, foco);
      const resplandor = halo(borde, new THREE.RingGeometry(0.56, 0.78, 64), 0.3);
      return { disco, borde, foco, resplandor };
    });

    // Fondo: un semicírculo de barras de luz de distinta altura y un arco detrás de los personajes.
    this.barras = Array.from({ length: BARRAS }, (_, i) => {
      const t = i / (BARRAS - 1);
      const angulo = (t - 0.5) * Math.PI * 0.95;
      const alto = 1.3 + 1.9 * (0.5 + 0.5 * Math.sin(i * 2.4)) * (0.55 + 0.45 * Math.cos(angulo));
      const barra = new THREE.Mesh(new THREE.BoxGeometry(0.1, alto, 0.1),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 }));
      barra.position.set(Math.sin(angulo) * RADIO_FONDO, alto / 2, -Math.cos(angulo) * RADIO_FONDO + 0.8);
      barra.userData = { t, fase: i * 0.7 };
      this.grupo.add(barra);
      barra.userData.halo = halo(barra, new THREE.BoxGeometry(0.34, alto * 1.04, 0.34), 0.16);
      return barra;
    });
    this.arco = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.03, 8, 96, Math.PI), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7 }));
    this.arco.position.set(0, 0, -2.4);
    this.grupo.add(this.arco);
    this.haloArco = halo(this.arco, new THREE.TorusGeometry(2.5, 0.13, 8, 96, Math.PI), 0.18);

    // Partículas que suben despacio, como polvo de luz.
    const posiciones = new Float32Array(PARTICULAS * 3);
    for (let i = 0; i < PARTICULAS; i++) {
      posiciones.set([(Math.random() - 0.5) * 10, Math.random() * 4.2, -4 + Math.random() * 4.6], i * 3);
    }
    this.particulas = new THREE.Points(new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 0.04, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.particulas.geometry.setAttribute("position", new THREE.BufferAttribute(posiciones, 3));
    this.grupo.add(this.particulas);

    this._fondo();
    this._anterior = performance.now();
    this.colorear();
  }

  /** Cielo con degradado, ciudad de neón a lo lejos, haces de luz y niebla: el escenario ya no flota en la nada. */
  _fondo() {
    this.cielos = { neon: cielo(["#05010f", "#1b0848", "#4a1173", "#ff2e97"]), sobrio: cielo(["#070a0f", "#0f151e", "#1a2333", "#2c3a50"]) };
    this.domo = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }));
    this.domo.position.y = -6;
    this.grupo.add(this.domo);

    // Edificios: cajas oscuras con ventanas encendidas y el borde de arriba de neón.
    const ventanas = texturaVentanas();
    this.edificios = [];
    for (let i = 0; i < 46; i++) {
      const angulo = (i / 45 - 0.5) * Math.PI * 1.25 + (Math.random() - 0.5) * 0.04;
      const radio = 15 + Math.random() * 7;
      const ancho = 1.2 + Math.random() * 1.8, alto = 2.5 + Math.random() ** 1.7 * 9;
      const mapa = ventanas.clone();
      mapa.needsUpdate = true;
      mapa.repeat.set(Math.max(1, Math.round(ancho * 1.5)), Math.max(1, Math.round(alto * 1.2)));
      mapa.offset.set(Math.random(), Math.random());
      const edificio = new THREE.Mesh(new THREE.BoxGeometry(ancho, alto, ancho),
        new THREE.MeshBasicMaterial({ color: 0xffffff, map: mapa }));
      const x = Math.sin(angulo) * radio, z = -Math.cos(angulo) * radio;
      edificio.position.set(x, alto / 2, z);
      edificio.lookAt(0, alto / 2, 0);
      const borde = new THREE.Mesh(new THREE.BoxGeometry(ancho * 1.02, 0.07, ancho * 1.02), new THREE.MeshBasicMaterial());
      borde.position.y = alto / 2;
      edificio.add(borde);
      edificio.userData = { borde, t: i / 45 };
      this.grupo.add(edificio);
      this.edificios.push(edificio);
    }

    // Haces de luz que barren el cielo desde detrás de la ciudad.
    this.haces = [-7, -2.5, 2.5, 7].map((x, i) => {
      const haz = new THREE.Mesh(new THREE.ConeGeometry(1.1, 26, 24, 1, true),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false,
          side: THREE.DoubleSide, fog: false }));
      haz.geometry.translate(0, -13, 0); // gira desde la base
      haz.rotation.x = Math.PI;
      const pivote = new THREE.Group();
      pivote.position.set(x, 0, -17);
      pivote.add(haz);
      pivote.userData = { fase: i * 1.7 };
      this.grupo.add(pivote);
      return pivote;
    });
    this.escena.fog = new THREE.Fog(0x12062b, 9, 30);
    this.ciudad = [...this.edificios, ...this.haces];
    this.cielos.playa = cielo(["#1b0c3a", "#6a2470", "#ff7a59", "#ffd27a"]);
    this.cielos.espacio = cielo(["#000004", "#04021a", "#0a0730", "#1a0b45"]);
    this.playa = this._playa();
    this.espacio = this._espacio();
    this.nombreAmbiente = "ciudad";
  }

  /** Playa al atardecer: sol enorme a rayas, mar oscuro y palmeras recortadas contra el cielo. */
  _playa() {
    const grupo = new THREE.Group();
    const sol = new THREE.Mesh(new THREE.CircleGeometry(6, 64),
      new THREE.MeshBasicMaterial({ color: "#ffb25a", fog: false }));
    sol.position.set(0, 4, -32);
    grupo.add(sol);
    for (let k = 0; k < 5; k++) { // franjas que cortan el sol, como en los atardeceres retro
      const franja = new THREE.Mesh(new THREE.PlaneGeometry(13, 0.35 + k * 0.12),
        new THREE.MeshBasicMaterial({ color: "#6a2470", fog: false }));
      franja.position.set(0, 0.6 + k * 1.15, -31.9);
      grupo.add(franja);
    }
    const mar = new THREE.Mesh(new THREE.RingGeometry(7.5, 45, 64),
      new THREE.MeshStandardMaterial({ color: "#2a1658", roughness: 0.25, metalness: 0.7 }));
    mar.rotation.x = -Math.PI / 2;
    mar.position.y = -0.02;
    grupo.add(mar);
    const silueta = new THREE.MeshBasicMaterial({ color: "#1a0b2e" });
    for (const [x, z, alto, inclina] of [[-8, -10, 5, 0.18], [-11, -14, 6.5, -0.12], [9, -11, 5.5, -0.2], [12.5, -15, 7, 0.1], [-15, -18, 4.5, 0.25]]) {
      const palmera = new THREE.Group();
      const tronco = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, alto, 8), silueta);
      tronco.position.y = alto / 2;
      palmera.add(tronco);
      for (let h = 0; h < 7; h++) {
        const hoja = new THREE.Mesh(new THREE.ConeGeometry(0.35, 2.6, 4), silueta);
        hoja.position.y = alto;
        hoja.rotation.set(1.2, (h / 7) * Math.PI * 2, 0);
        hoja.translateY(1.2);
        palmera.add(hoja);
      }
      palmera.position.set(x, 0, z);
      palmera.rotation.z = inclina;
      grupo.add(palmera);
    }
    grupo.visible = false;
    this.grupo.add(grupo);
    return grupo;
  }

  /** Espacio: miles de estrellas, un planeta con anillo y su luna. */
  _espacio() {
    const grupo = new THREE.Group();
    const puntos = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(34);
      if (v.y < -2) v.y = -v.y; // solo en el cielo, no bajo el piso
      puntos.set([v.x, v.y, v.z], i * 3);
    }
    const estrellas = new THREE.Points(new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: "#ffffff", size: 0.12, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.9 }));
    estrellas.geometry.setAttribute("position", new THREE.BufferAttribute(puntos, 3));
    grupo.add(estrellas);
    const planeta = new THREE.Mesh(new THREE.SphereGeometry(5, 48, 24),
      new THREE.MeshStandardMaterial({ color: "#7b4dff", emissive: "#2a0f6b", emissiveIntensity: 0.6, roughness: 0.8, fog: false }));
    planeta.position.set(-13, 9, -30);
    const anillo = new THREE.Mesh(new THREE.RingGeometry(6.5, 9, 96),
      new THREE.MeshBasicMaterial({ color: "#ff8bd0", side: THREE.DoubleSide, transparent: true, opacity: 0.55, fog: false }));
    anillo.rotation.set(1.25, 0.2, 0);
    planeta.add(anillo);
    const luna = new THREE.Mesh(new THREE.SphereGeometry(1.2, 32, 16),
      new THREE.MeshStandardMaterial({ color: "#d8d2ff", emissive: "#3a3060", emissiveIntensity: 0.5, fog: false }));
    luna.position.set(14, 12, -28);
    grupo.add(planeta, luna);
    grupo.userData = { planeta, estrellas };
    grupo.visible = false;
    this.grupo.add(grupo);
    return grupo;
  }

  /** Cambia el lugar del escenario: "ciudad", "playa" o "espacio". */
  ambiente(nombre) {
    this.nombreAmbiente = ["ciudad", "playa", "espacio"].includes(nombre) ? nombre : "ciudad";
    this.colorear(this.sobrio);
  }

  /** Vuelve a leer los colores del tema. `sobrio`: sin partículas ni focos, y con las luces quietas. */
  colorear(sobrio = false) {
    this.sobrio = sobrio;
    const guia = new THREE.Color(this.token("--guia")), jugador = new THREE.Color(this.token("--avatar"));
    const [izquierda, derecha] = sobrio
      ? [new THREE.Color(this.token("--suave")), new THREE.Color(this.token("--acento"))]
      : [guia, jugador];
    this.pisoMaterial.color.set(sobrio ? "#1a2230" : this.token("--piso"));
    this.rejillaMaterial.color.copy(sobrio ? izquierda : new THREE.Color(this.token("--morado")));
    this.rejillaMaterial.opacity = sobrio ? 0.12 : 0.22;
    for (const [i, { disco, borde, foco }] of this.plataformas.entries()) {
      const color = sobrio ? derecha : (i === 0 ? guia : jugador);
      disco.material.color.copy(color).multiplyScalar(0.25);
      borde.material.color.copy(color);
      borde.material.opacity = sobrio ? 0.6 : 0.95;
      foco.material.color.copy(color);
      foco.visible = !sobrio;
    }
    for (const barra of this.barras) {
      barra.userData.color = izquierda.clone().lerp(derecha, barra.userData.t);
      barra.material.color.copy(barra.userData.color);
      barra.material.opacity = sobrio ? 0.16 : 0.5;
    }
    this.arco.material.color.copy(sobrio ? derecha : new THREE.Color(this.token("--resalte")));
    this.arco.material.opacity = sobrio ? 0.35 : 0.7;
    this.particulas.visible = !sobrio;
    this.particulas.material.color.copy(sobrio ? derecha : new THREE.Color("#ffffff"));
    this.contornos[0].color.copy(sobrio ? new THREE.Color("#ffffff") : guia);
    this.contornos[1].color.copy(sobrio ? new THREE.Color("#ffffff") : jugador);
    for (const luz of this.contornos) luz.intensity = sobrio ? 0.5 : 1.1;
    if (!this.domo || !this.playa) return;
    // El tema profesional usa siempre la ciudad en grises: los lugares desbloqueables son del tema actual.
    const lugar = sobrio ? "ciudad" : this.nombreAmbiente;
    for (const o of this.ciudad) o.visible = lugar === "ciudad";
    this.playa.visible = lugar === "playa";
    this.espacio.visible = lugar === "espacio";
    this.domo.material.map = sobrio ? this.cielos.sobrio : { ciudad: this.cielos.neon, playa: this.cielos.playa, espacio: this.cielos.espacio }[lugar];
    this.domo.material.needsUpdate = true;
    this.escena.fog.color.set(sobrio ? "#0d121a" : { ciudad: "#1d0a45", playa: "#4a1d55", espacio: "#06041c" }[lugar]);
    this.escena.fog.far = lugar === "ciudad" ? 30 : 45;
    const neones = [this.token("--cian"), this.token("--rosa"), this.token("--morado"), this.token("--amarillo")];
    for (const [i, e] of this.edificios.entries()) {
      e.material.color.set(sobrio ? "#5d6b80" : "#ffffff");
      e.userData.borde.material.color.set(sobrio ? "#3a4659" : neones[i % neones.length]);
    }
    for (const [i, h] of this.haces.entries()) {
      h.visible = !sobrio && lugar === "ciudad";
      h.children[0].material.color.set(i % 2 ? this.token("--rosa") : this.token("--cian"));
    }
  }

  /** Destello de todo el decorado (al lograr una repetición o terminar la serie). */
  destello(color, fuerza = 1) {
    this._colorPulso.set(color);
    this._pulso = fuerza;
  }

  animar(t) {
    const dt = Math.min(0.05, (t - this._anterior) / 1000);
    this._anterior = t;
    this._pulso = Math.max(0, this._pulso - dt * 1.6);
    const s = t / 1000;
    for (const barra of this.barras) {
      const { color, fase } = barra.userData;
      const onda = this.sobrio ? 0 : 0.5 + 0.5 * Math.sin(s * 1.3 + fase);
      barra.material.color.copy(color).lerp(this._colorPulso, this._pulso * 0.85);
      barra.material.opacity = (this.sobrio ? 0.16 : 0.32 + 0.3 * onda) + this._pulso * 0.4;
      if (!this.sobrio) barra.scale.y = 1 + 0.05 * onda + this._pulso * 0.12;
      barra.userData.halo.actualizar(this.sobrio ? 0 : 0.6 + 0.6 * onda + this._pulso * 1.5);
    }
    this.arco.material.opacity = (this.sobrio ? 0.35 : 0.55 + 0.15 * Math.sin(s * 0.9)) + this._pulso * 0.3;
    this.haloArco.actualizar(this.sobrio ? 0 : 1 + this._pulso * 1.5);
    for (const { resplandor } of this.plataformas) resplandor.actualizar(this.sobrio ? 0.3 : 1 + this._pulso);
    if (this.sobrio) return;
    if (this.espacio?.visible) {
      this.espacio.userData.planeta.rotation.y = s * 0.04;
      this.espacio.userData.estrellas.rotation.y = s * 0.004;
    }
    for (const h of this.haces) {
      h.rotation.z = 0.35 * Math.sin(s * 0.35 + h.userData.fase);
      h.rotation.x = -0.25 + 0.1 * Math.sin(s * 0.27 + h.userData.fase);
    }
    for (const [i, { foco }] of this.plataformas.entries()) {
      foco.material.opacity = 0.05 + 0.02 * Math.sin(s * 0.8 + i * 2) + this._pulso * 0.1;
    }
    const posiciones = this.particulas.geometry.attributes.position;
    for (let i = 0; i < posiciones.count; i++) {
      let y = posiciones.getY(i) + dt * (0.08 + (i % 7) * 0.015);
      if (y > 4.2) y = 0;
      posiciones.setY(i, y);
      posiciones.setX(i, posiciones.getX(i) + Math.sin(s * 0.5 + i) * dt * 0.03);
    }
    posiciones.needsUpdate = true;
  }
}
