// Fondo de estrellas para toda la página: en el menú se viaja entre ellas y cruzan estrellas
// fugaces; en las demás pantallas se mueven despacio, y durante el ejercicio quedan quietas para
// no quitarle cuadros por segundo a la escena 3D.
const COLORES = ["#ffffff", "#ffffff", "#ffffff", "#c9bbff", "#00e5ff", "#ff2e97", "#ffe14d"];
// velocidad: profundidad recorrida por segundo; fugaces: cada cuántos segundos sale una (0 = nunca).
const MODOS = {
  menu: { velocidad: 0.085, fugaces: 3.5 },
  calmo: { velocidad: 0.018, fugaces: 9 },
  quieto: { velocidad: 0, fugaces: 0 },
};
const CERCA = 0.06; // profundidad a la que la estrella ya pasó de largo
const SIN_MOVIMIENTO = window.matchMedia("(prefers-reduced-motion: reduce)");

export class Estrellas {
  /** @param {HTMLCanvasElement} lienzo cubre toda la ventana, detrás de las pantallas */
  constructor(lienzo) {
    this.lienzo = lienzo;
    this.ctx = lienzo.getContext("2d");
    this.estrellas = [];
    this.fugaces = [];
    this.velocidad = 0;
    this.objetivo = MODOS.menu;
    this.proximaFugaz = 1.5;
    this.raton = { x: 0, y: 0 }; // de −1 a 1: el centro del viaje se corre un poco hacia el cursor
    this.centro = { x: 0, y: 0 };
    this._anterior = null;
    this._cuadro = null;
    this.horizonte = 1; // 0–1: el horizonte de rejilla del menú aparece y se va con un fundido
    this._avance = 0; // cuánto avanzó la rejilla hacia el jugador
    window.addEventListener("resize", () => this._ajustar());
    window.addEventListener("pointermove", (e) => {
      this.raton.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.raton.y = (e.clientY / window.innerHeight) * 2 - 1;
    });
    SIN_MOVIMIENTO.addEventListener("change", () => this.modo(this._nombre));
    this._ajustar();
    this.modo("menu");
  }

  /** @param {"menu"|"calmo"|"quieto"} nombre */
  modo(nombre) {
    this._nombre = nombre;
    this.objetivo = SIN_MOVIMIENTO.matches ? MODOS.quieto : MODOS[nombre];
    if (this._cuadro === null) {
      this._anterior = null;
      this._cuadro = requestAnimationFrame((t) => this._animar(t));
    }
  }

  _ajustar() {
    const escala = Math.min(window.devicePixelRatio || 1, 2);
    const ancho = window.innerWidth, alto = window.innerHeight;
    this.lienzo.width = Math.round(ancho * escala);
    this.lienzo.height = Math.round(alto * escala);
    this.ctx.setTransform(escala, 0, 0, escala, 0, 0);
    this.ancho = ancho;
    this.alto = alto;
    const cantidad = Math.min(420, Math.max(120, Math.round((ancho * alto) / 4200)));
    while (this.estrellas.length < cantidad) this.estrellas.push(this._nueva(Math.random()));
    this.estrellas.length = cantidad;
    this._dibujar(0);
  }

  _nueva(z) {
    return {
      x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: CERCA + z * (1 - CERCA),
      radio: 0.5 + Math.random() ** 3 * 1.6,
      color: COLORES[Math.floor(Math.random() * COLORES.length)],
      fase: Math.random() * Math.PI * 2, ritmo: 0.6 + Math.random() * 2.2,
    };
  }

  _animar(t) {
    const dt = this._anterior === null ? 0 : Math.min(0.05, (t - this._anterior) / 1000);
    this._anterior = t;
    // La velocidad cambia de a poco: al entrar o salir del menú se siente acelerar o frenar.
    this.velocidad += (this.objetivo.velocidad - this.velocidad) * Math.min(1, dt * 2.5);
    this.centro.x += (this.raton.x * 0.06 - this.centro.x) * Math.min(1, dt * 2);
    this.centro.y += (this.raton.y * 0.06 - this.centro.y) * Math.min(1, dt * 2);
    this.horizonte += ((this._nombre === "menu" ? 1 : 0) - this.horizonte) * Math.min(1, dt * 3);
    this._avance += dt * 0.45 * this.horizonte * (SIN_MOVIMIENTO.matches ? 0 : 1);
    for (const e of this.estrellas) {
      e.z -= this.velocidad * dt;
      if (e.z < CERCA) Object.assign(e, this._nueva(1));
    }
    if (this.objetivo.fugaces) {
      this.proximaFugaz -= dt;
      if (this.proximaFugaz <= 0) {
        this.proximaFugaz = this.objetivo.fugaces * (0.5 + Math.random());
        this._lanzarFugaz();
      }
    }
    for (const f of this.fugaces) { f.vida += dt; f.x += f.vx * dt; f.y += f.vy * dt; }
    this.fugaces = this.fugaces.filter((f) => f.vida < f.duracion);
    this._dibujar(t / 1000);
    const quieto = this.objetivo.velocidad === 0 && this.velocidad < 0.001 && !this.fugaces.length && this.horizonte < 0.01;
    this._cuadro = quieto ? null : requestAnimationFrame((u) => this._animar(u));
  }

  _lanzarFugaz() {
    const haciaDerecha = Math.random() < 0.5;
    const rapidez = 700 + Math.random() * 500;
    const angulo = (18 + Math.random() * 22) * Math.PI / 180;
    this.fugaces.push({
      x: this.ancho * (haciaDerecha ? Math.random() * 0.5 : 0.5 + Math.random() * 0.5),
      y: this.alto * Math.random() * 0.35,
      vx: Math.cos(angulo) * rapidez * (haciaDerecha ? 1 : -1), vy: Math.sin(angulo) * rapidez,
      vida: 0, duracion: 0.7 + Math.random() * 0.5,
    });
  }

  /** Tres nubes de color muy suaves que se desplazan despacio: dan profundidad al fondo. */
  _nebulosas(segundos) {
    const { ctx, ancho, alto } = this;
    const nubes = [[0.18, 0.3, "255 46 151"], [0.82, 0.22, "0 229 255"], [0.55, 0.62, "139 92 255"]];
    for (const [i, [nx, ny, rgb]] of nubes.entries()) {
      const x = ancho * (nx + 0.04 * Math.sin(segundos * 0.05 + i * 2));
      const y = alto * (ny + 0.03 * Math.cos(segundos * 0.04 + i));
      const r = Math.max(ancho, alto) * 0.42;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgb(${rgb} / ${0.13 + 0.05 * this.horizonte})`);
      g.addColorStop(1, `rgb(${rgb} / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, ancho, alto);
    }
  }

  /** Horizonte del menú: un resplandor de neón y un piso de rejilla que avanza hacia el jugador. */
  _rejilla() {
    const { ctx, ancho, alto } = this;
    const h = alto * 0.78, vx = ancho * (0.5 + this.centro.x * 0.5), fondo = alto - h;
    ctx.save();
    ctx.globalAlpha = this.horizonte;
    // Resplandor del horizonte y piso oscuro bajo la rejilla.
    const brillo = ctx.createLinearGradient(0, h - 40, 0, h + 30);
    brillo.addColorStop(0, "rgb(255 46 151 / 0)");
    brillo.addColorStop(0.55, "rgb(255 46 151 / .45)");
    brillo.addColorStop(1, "rgb(255 46 151 / 0)");
    ctx.fillStyle = brillo;
    ctx.fillRect(0, h - 40, ancho, 70);
    const piso = ctx.createLinearGradient(0, h, 0, alto);
    piso.addColorStop(0, "rgb(18 6 43 / .55)");
    piso.addColorStop(1, "rgb(18 6 43 / .9)");
    ctx.fillStyle = piso;
    ctx.fillRect(0, h, ancho, fondo);
    // Líneas que van al punto de fuga.
    ctx.lineWidth = 1.2;
    const paso = ancho / 9;
    const vertical = ctx.createLinearGradient(0, h, 0, alto);
    vertical.addColorStop(0, "rgb(139 92 255 / 0)");
    vertical.addColorStop(1, "rgb(255 46 151 / .55)");
    ctx.strokeStyle = vertical;
    for (let i = -14; i <= 14; i++) {
      ctx.beginPath();
      ctx.moveTo(vx + i * paso * 0.06, h);
      ctx.lineTo(vx + i * paso * 1.6, alto);
      ctx.stroke();
    }
    // Líneas horizontales en perspectiva: se acercan solas.
    const frac = this._avance % 1;
    for (let k = 0; k < 22; k++) {
      const z = 1 + k - frac;
      const y = h + fondo * (1 / z) ** 1.25;
      ctx.strokeStyle = `rgb(255 46 151 / ${0.55 * Math.min(1, (y - h) / (fondo * 0.25))})`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(ancho, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _dibujar(segundos) {
    const { ctx, ancho, alto } = this;
    ctx.clearRect(0, 0, ancho, alto);
    this._nebulosas(segundos);
    if (this.horizonte > 0.01) this._rejilla();
    const cx = ancho * (0.5 + this.centro.x), cy = alto * (0.5 + this.centro.y);
    const alcance = Math.max(ancho, alto) * 0.6;
    const estela = this.velocidad * 0.7; // cuánto se estira cada estrella al viajar
    for (const e of this.estrellas) {
      const x = cx + (e.x / e.z) * alcance * CERCA * 4, y = cy + (e.y / e.z) * alcance * CERCA * 4;
      if (x < -20 || x > ancho + 20 || y < -20 || y > alto + 20) continue;
      const cercania = 1 - e.z;
      const titileo = 0.65 + 0.35 * Math.sin(e.fase + segundos * e.ritmo);
      const radio = e.radio * (0.5 + cercania * 0.8);
      // Aparecen de a poco al fondo y se apagan justo antes de pasar de largo.
      ctx.globalAlpha = Math.min(1, 0.2 + cercania, (e.z - CERCA) / 0.04) * titileo;
      ctx.fillStyle = ctx.strokeStyle = e.color;
      if (estela > 0.01 && cercania > 0.4) {
        // Trazo desde donde estaba un instante antes: da la sensación de avanzar.
        const zAntes = e.z * (1 + estela);
        ctx.lineWidth = radio * 1.2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx + (e.x / zAntes) * alcance * CERCA * 4, cy + (e.y / zAntes) * alcance * CERCA * 4);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, radio, 0, Math.PI * 2);
        ctx.fill();
      }
      if (radio > 1.7) { // las más cercanas llevan un halo
        ctx.globalAlpha *= 0.18;
        ctx.beginPath();
        ctx.arc(x, y, radio * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const f of this.fugaces) {
      const avance = f.vida / f.duracion;
      const largo = 0.16; // segundos de cola
      const cola = ctx.createLinearGradient(f.x, f.y, f.x - f.vx * largo, f.y - f.vy * largo);
      cola.addColorStop(0, "rgb(255 255 255 / 1)");
      cola.addColorStop(0.3, "rgb(0 229 255 / .6)");
      cola.addColorStop(1, "rgb(255 46 151 / 0)");
      ctx.globalAlpha = Math.sin(avance * Math.PI);
      ctx.strokeStyle = cola;
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(f.x, f.y);
      ctx.lineTo(f.x - f.vx * largo, f.y - f.vy * largo);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
