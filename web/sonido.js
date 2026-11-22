// Música de ambiente y efectos, generados en el navegador con Web Audio: no hay archivos de audio,
// funciona sin internet y no hay licencias de música que citar.
//
// Para usar pistas grabadas más adelante basta cambiar `musica()`: el resto del juego solo pide
// una pista por nombre ("menu", "ejercicio") y un efecto por nombre (EFECTOS).
const CLAVES = { silencio: "sonido_silencio", musica: "sonido_musica", efectos: "sonido_efectos" };
const VOLUMEN_INICIAL = { musica: 0.5, efectos: 0.8 };
const CAMBIO_PISTA_S = 1.5; // fundido entre pistas
const ADELANTO_S = 0.4; // cuánto se programa por adelantado (el temporizador del navegador no es exacto)

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function leer(clave) {
  try { return localStorage.getItem(clave); } catch { return null; }
}
function guardar(clave, valor) {
  try { localStorage.setItem(clave, String(valor)); } catch { /* sin almacenamiento: no pasa nada */ }
}
function numero(clave, porDefecto) {
  const v = Number.parseFloat(leer(clave));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : porDefecto;
}

/** Una nota con envolvente suave. `tipo`: forma de onda; `brillo`: frecuencia de corte del filtro. */
function nota(ctx, destino, t, frecuencia, duracion, { tipo = "sine", vol = 0.2, ataque = 0.01, brillo = 6000, hasta = null } = {}) {
  const osc = ctx.createOscillator();
  const filtro = ctx.createBiquadFilter();
  const env = ctx.createGain();
  osc.type = tipo;
  osc.frequency.setValueAtTime(frecuencia, t);
  if (hasta) osc.frequency.exponentialRampToValueAtTime(hasta, t + duracion);
  filtro.type = "lowpass";
  filtro.frequency.value = brillo;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(vol, t + ataque);
  env.gain.exponentialRampToValueAtTime(0.0001, t + duracion);
  osc.connect(filtro).connect(env).connect(destino);
  osc.start(t);
  osc.stop(t + duracion + 0.05);
}

/** Campana: la fundamental y un armónico que se apaga antes, como una marimba suave. */
function campana(ctx, destino, t, midi, duracion = 0.7, vol = 0.22) {
  nota(ctx, destino, t, hz(midi), duracion, { vol, ataque: 0.005 });
  nota(ctx, destino, t, hz(midi) * 2, duracion * 0.45, { vol: vol * 0.3, ataque: 0.005 });
}

function acorde(ctx, destino, t, notas, duracion, vol) {
  for (const midi of notas) {
    // Dos osciladores levemente desafinados dan un colchón de sonido cálido.
    nota(ctx, destino, t, hz(midi) * 0.998, duracion, { tipo: "triangle", vol, ataque: duracion * 0.3, brillo: 1500 });
    nota(ctx, destino, t, hz(midi) * 1.002, duracion, { tipo: "sine", vol, ataque: duracion * 0.3, brillo: 1500 });
  }
}

// --- pistas ----------------------------------------------------------------------------------
// Cada paso es una corchea. Melodías en pentatónica: casi cualquier combinación suena bien.
const PENTATONICA = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81];

/** Generador simple con semilla: la música varía entre compases, pero siempre suena igual al empezar. */
function azar(semilla) {
  let s = semilla;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

const PISTAS = {
  // Menú: alegre y tranquila.
  menu: {
    pulsos: 100,
    nivel: 2.5,
    crear() {
      const r = azar(7);
      const acordes = [[48, 60, 64, 67, 71], [45, 57, 60, 64, 67], [41, 57, 60, 65, 69], [43, 55, 59, 62, 67]];
      let lugar = 4;
      return (ctx, destino, t, paso, corchea) => {
        const a = acordes[Math.floor(paso / 8) % acordes.length];
        if (paso % 8 === 0) {
          acorde(ctx, destino, t, a.slice(1), corchea * 8.5, 0.028);
          nota(ctx, destino, t, hz(a[0]), corchea * 3, { tipo: "triangle", vol: 0.11, ataque: 0.02, brillo: 700 });
        }
        if (paso % 8 === 4) nota(ctx, destino, t, hz(a[0]), corchea * 2, { tipo: "triangle", vol: 0.07, ataque: 0.02, brillo: 700 });
        if (paso % 2 === 0) campana(ctx, destino, t, a[1 + (paso / 2) % 4] + 12, corchea * 2.4, 0.035);
        // Melodía: camina por la escala, descansa la mitad de los compases.
        if (Math.floor(paso / 16) % 2 === 1 && (paso % 4 === 0 || r() < 0.2)) {
          lugar = Math.max(2, Math.min(PENTATONICA.length - 1, lugar + Math.floor(r() * 5) - 2));
          campana(ctx, destino, t, PENTATONICA[lugar] + 12, corchea * 3.5, 0.06);
        }
      };
    },
  },
  // Ejercicio: lenta y discreta, para que se oigan los efectos de cada repetición.
  ejercicio: {
    pulsos: 66,
    nivel: 1.5,
    crear() {
      const r = azar(11);
      const acordes = [[41, 57, 60, 64], [48, 55, 60, 64], [45, 57, 60, 65], [46, 58, 62, 65]];
      return (ctx, destino, t, paso, corchea, capa) => {
        const a = acordes[Math.floor(paso / 16) % acordes.length];
        if (paso % 16 === 0) {
          acorde(ctx, destino, t, a.slice(1), corchea * 17, 0.022);
          nota(ctx, destino, t, hz(a[0]), corchea * 14, { tipo: "sine", vol: 0.07, ataque: 0.5, brillo: 500 });
        }
        if (paso % 4 === 2 && r() < 0.45) campana(ctx, destino, t, a[1 + Math.floor(r() * 3)] + 12, corchea * 5, 0.022);
        // Capa de ritmo: sube cuando el jugador se mueve y baja cuando descansa (fijarIntensidad).
        if (capa) {
          if (paso % 4 === 0) nota(ctx, capa, t, 120, 0.22, { vol: 0.32, ataque: 0.003, brillo: 900, hasta: 42 }); // bombo
          if (paso % 4 === 2) nota(ctx, capa, t, hz(a[0] + 12), corchea * 1.8, { tipo: "triangle", vol: 0.08, ataque: 0.01, brillo: 900 });
          campana(ctx, capa, t, a[1 + (paso % 3)] + 24, corchea * 1.4, 0.03); // arpegio en corcheas
        }
      };
    },
  },
};

// --- efectos ---------------------------------------------------------------------------------
const SECUENCIA = (notas, separacion, duracion, vol) => (ctx, destino, t) =>
  notas.forEach((midi, i) => campana(ctx, destino, t + i * separacion, midi, duracion, vol));

export const EFECTOS = {
  perfecto: SECUENCIA([72, 76, 79, 84], 0.075, 0.6, 0.26), // sube y brilla
  bien: SECUENCIA([76, 79], 0.09, 0.45, 0.22), // válida, sin pasar la meta
  casi: SECUENCIA([69, 67], 0.16, 0.4, 0.17), // «uy, casi»: suave, baja un paso
  // Grave y corto, sin zumbido de error: quien tiene dolor va a fallar seguido.
  mal: (ctx, destino, t) => nota(ctx, destino, t, hz(50), 0.38, { tipo: "triangle", vol: 0.2, ataque: 0.015, brillo: 650, hasta: hz(45) }),
  cuenta: (ctx, destino, t) => nota(ctx, destino, t, hz(81), 0.1, { tipo: "triangle", vol: 0.13, ataque: 0.003, brillo: 3500 }),
  ya: SECUENCIA([84], 0, 0.55, 0.25),
  aviso: SECUENCIA([72, 79], 0.1, 0.4, 0.15), // te veo, intento registrado
  logro: SECUENCIA([72, 76, 79], 0.1, 0.55, 0.2), // calibrado
  serie: (ctx, destino, t) => {
    SECUENCIA([72, 76, 79, 84], 0.11, 0.8, 0.22)(ctx, destino, t);
    for (const midi of [72, 76, 79, 84]) campana(ctx, destino, t + 0.5, midi, 1.4, 0.13);
  },
};

const POR_EVENTO = { vista_ok: "aviso", intento_calibracion: "aviso", calibracion_lista: "logro", calibracion_fallida: "casi" };

export class Sonido {
  constructor() {
    this.ctx = null;
    this.pedida = null; // pista que corresponde a la pantalla, aunque el audio siga bloqueado
    this.pista = null;
    this.intensidad = 0;
    this.silencio = leer(CLAVES.silencio) === "1";
    this.volumen = { musica: numero(CLAVES.musica, VOLUMEN_INICIAL.musica), efectos: numero(CLAVES.efectos, VOLUMEN_INICIAL.efectos) };
    // El navegador no deja sonar nada hasta el primer gesto del usuario.
    const desbloquear = () => this._desbloquear();
    for (const evento of ["pointerdown", "keydown"]) document.addEventListener(evento, desbloquear, { capture: true });
    // Sin la página a la vista el temporizador se frena y la música tartamudearía.
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    });
  }

  _desbloquear() {
    if (!window.AudioContext) return;
    if (!this.ctx) this._crear();
    if (this.ctx.state === "suspended") this.ctx.resume();
    if (this.pedida && !this.pista) this.musica(this.pedida);
  }

  _crear() {
    const ctx = this.ctx = new AudioContext();
    this.maestro = ctx.createGain();
    this.maestro.gain.value = this.silencio ? 0 : 1;
    const limitador = ctx.createDynamicsCompressor();
    this.maestro.connect(limitador).connect(ctx.destination);
    this.busMusica = ctx.createGain();
    this.busEfectos = ctx.createGain();
    this.busMusica.gain.value = this.volumen.musica;
    this.busEfectos.gain.value = this.volumen.efectos;
    this.busMusica.connect(this.maestro);
    this.busEfectos.connect(this.maestro);
    // Eco suave: una sala hecha con ruido que se apaga.
    const sala = ctx.createConvolver();
    sala.buffer = this._respuestaSala();
    const envio = ctx.createGain();
    envio.gain.value = 0.28;
    this.busMusica.connect(envio);
    this.busEfectos.connect(envio);
    envio.connect(sala).connect(this.maestro);
    setInterval(() => this._programar(), 100);
  }

  _respuestaSala() {
    const { ctx } = this;
    const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.6), ctx.sampleRate);
    for (let canal = 0; canal < 2; canal++) {
      const datos = buffer.getChannelData(canal);
      for (let i = 0; i < datos.length; i++) datos[i] = (Math.random() * 2 - 1) * (1 - i / datos.length) ** 3;
    }
    return buffer;
  }

  /** Cambia de pista con un fundido; `null` la apaga. No reinicia la que ya está sonando. */
  musica(nombre) {
    this.pedida = nombre;
    if (!this.ctx || nombre === this.pista?.nombre) return;
    const ahora = this.ctx.currentTime;
    if (this.pista) {
      const vieja = this.pista.salida;
      vieja.gain.setTargetAtTime(0, ahora, CAMBIO_PISTA_S / 3);
      setTimeout(() => vieja.disconnect(), (CAMBIO_PISTA_S + 3) * 1000);
    }
    this.pista = null;
    if (!nombre) return;
    const salida = this.ctx.createGain();
    salida.gain.setValueAtTime(0.0001, ahora);
    const { pulsos, crear, nivel } = PISTAS[nombre];
    salida.gain.setTargetAtTime(nivel, ahora, CAMBIO_PISTA_S / 3);
    salida.connect(this.busMusica);
    const capa = this.ctx.createGain();
    capa.gain.value = this.intensidad;
    capa.connect(salida);
    this.pista = { nombre, salida, capa, tocar: crear(), corchea: 30 / pulsos, paso: 0, siguiente: ahora + 0.05 };
    this._programar();
  }

  _programar() {
    const p = this.pista;
    if (!p || this.ctx.state !== "running") return;
    // Tras una pausa larga no se tocan de golpe las notas atrasadas.
    if (p.siguiente < this.ctx.currentTime) p.siguiente = this.ctx.currentTime + 0.05;
    while (p.siguiente < this.ctx.currentTime + ADELANTO_S) {
      p.tocar(this.ctx, p.salida, p.siguiente, p.paso, p.corchea, p.capa);
      p.paso += 1;
      p.siguiente += p.corchea;
    }
  }

  /** 0–1: cuánto ritmo lleva la música del ejercicio (0 en reposo o fuera del juego). */
  fijarIntensidad(valor) {
    if (valor === this.intensidad) return;
    this.intensidad = valor;
    if (this.ctx && this.pista?.capa) this.pista.capa.gain.setTargetAtTime(valor, this.ctx.currentTime, 0.6);
  }

  efecto(nombre, retraso = 0) {
    if (!this.ctx || this.ctx.state !== "running") return;
    EFECTOS[nombre]?.(this.ctx, this.busEfectos, this.ctx.currentTime + retraso);
  }

  /** Los eventos del servicio que suenan. */
  evento(msg) {
    if (msg.nombre === "rep_valida" || msg.nombre === "rep_incompleta") this.efecto(msg.calidad);
    else if (msg.nombre === "serie_completa") this.efecto("serie", 0.35); // después del sonido de la última repetición
    else if (POR_EVENTO[msg.nombre]) this.efecto(POR_EVENTO[msg.nombre]);
  }

  /** @param {"musica"|"efectos"} tipo @param {number} valor de 0 a 1 */
  fijarVolumen(tipo, valor) {
    this.volumen[tipo] = valor;
    guardar(CLAVES[tipo], valor);
    if (this.ctx) (tipo === "musica" ? this.busMusica : this.busEfectos).gain.setTargetAtTime(valor, this.ctx.currentTime, 0.03);
  }

  fijarSilencio(si) {
    this.silencio = si;
    guardar(CLAVES.silencio, si ? "1" : "0");
    if (this.ctx) this.maestro.gain.setTargetAtTime(si ? 0 : 1, this.ctx.currentTime, 0.03);
  }
}

export const sonido = new Sonido();
