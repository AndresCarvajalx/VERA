// Sesión guiada: después de elegir el personaje todo avanza solo, con temporizadores, para que el
// jugador no tenga que acercarse al computador a dar clics:
//
//   intro (5 s) → encuadre (3 s de cuerpo completo a la vista) → «¡Calibrado!» → elegir ejercicio
//   → «Calibrando rangos de movimiento para X» (5 s y calibración del rango: reposo + 3 intentos)
//   → rango y meta adaptada → «Prepárate para iniciar» (5…0) → repeticiones → resultado.
//
// La meta sale de la calibración de hoy (vision/api/adaptacion.py): el juego se adapta al rango de
// cada jugador y la barra de ejecución se dibuja relativa a esa meta, no al rango normal.
import { sonido } from "./sonido.js";
import { voz } from "./voz.js";
const $ = (id) => document.getElementById(id);

const LADOS = { der: "derecha", izq: "izquierda" };
const POSICION = { de_pie: "De pie", sentado: "Sentado" };
// Calentamiento antes de calibrar: tres movimientos suaves que la guía muestra con poca amplitud.
const CALENTAMIENTO = [
  { titulo: "Dobla la rodilla suave", articulacion: "rodilla", sentido: 1, objetivo: 35 },
  { titulo: "Sube la rodilla un poco", articulacion: "cadera", sentido: 1, objetivo: 30 },
  { titulo: "Mueve el tobillo", articulacion: "tobillo", sentido: 1, objetivo: 12 },
];
const SEGUNDOS_POR_CALENTAMIENTO = 15;
const SEGUNDOS = { intro: 5, encuadre: 3, calibrado: 3, previa: 5, rango: 5, preparate: 5, otro: 15, reintento: 8 };
const ESTADOS = {
  preparacion: "Ponte en la posición inicial", reposo: "¡Empieza!", subiendo: "Vas bien…",
  en_objetivo: "¡Sostén!", bajando: "Vuelve despacio",
};
const FASES = { pausado: "En pausa", no_visible: "No veo esa pierna", verificando_vista: "Ponte de lado" };
/** Lo que se muestra según la `calidad` de la repetición. Nunca se le dice «mal» al jugador. */
export const CELEBRACION = {
  perfecto: ["¡PERFECTO!", "perfecto"], bien: ["¡BIEN!", "bien"], casi: ["¡CASI!", "casi"], mal: ["¡SIGUE!", "casi"],
};
const MOTIVOS_REP = { no_llego: "no llegaste a la meta", no_sostuvo: "no sostuviste el tiempo", compensacion: "hubo compensación" };
const META_EN_BARRA = 0.8; // la meta queda al 80 % de la barra: se ve cuándo se pasa de ella

export class Flujo {
  /**
   * @param {object} d dependencias de la página (prueba.js)
   * @param {(nombre: string, datos?: object) => void} d.enviar comando al servicio de visión
   * @param {(msg: object, lienzo: HTMLCanvasElement) => void} d.dibujar esqueleto 2D
   * @param {(msg: object) => string} d.textoAviso qué parte del cuerpo no se ve
   * @param {() => object} d.ejercicios catálogo por clave
   * @param {() => object[]} d.progreso series de progreso del jugador
   * @param {(clave: string, lado: string) => void} d.elegirEjercicio sincroniza la escena y el panel
   * @param {(modo: string) => void} d.mostrarGuia "inicial" | "normal" | "meta"
   * @param {(resumen: object) => Promise<boolean>} d.guardarResumen
   * @param {() => Promise<object>} d.cargarPlan plan adaptado del ejercicio elegido
   * @param {(pantalla: string) => void} d.irA
   * @param {(clave: string, valor: string) => void} d.recordar
   * @param {(clave: string) => string|null} d.recuperar
   * @param {import("./logros.js").Logros} d.logros racha y logros del jugador
   * @param {(ejercicio: object) => void} d.demostrar la guía hace un movimiento (calentamiento)
   * @param {(jugador: string) => Promise<void>} d.tutorial muestra el tutorial si es la primera vez
   * @param {import("./encuesta.js").Encuesta} d.encuesta encuesta de usabilidad SUS
   */
  constructor(d) {
    this.d = d;
    this.etapa = null;
    this.lado = d.recuperar("lado") === "izq" ? "izq" : "der";
    this.clave = null;
    this.plan = null;
    this.pausado = false;
    this.encuadreHecho = false;
    this._t = null;
    this._avisoHasta = 0;
    this._estadoHasta = 0;
    $("btn_sesion_pausa").addEventListener("click", () => this.pausar(!this.pausado));
    $("btn_sesion_detener").addEventListener("click", () => this.detener());
    for (const b of $("paso_lado").querySelectorAll("[data-lado]")) {
      b.addEventListener("click", () => {
        this.lado = b.dataset.lado;
        this.d.recordar("lado", this.lado);
        this._pintarEjercicios();
      });
    }
  }

  get regla() { return this.d.ejercicios()[this.clave]; }

  // --- entrar y salir de la pantalla --------------------------------------------
  /** Al llegar a la sesión: la primera vez se calibra el encuadre; después se vuelve a elegir ejercicio. */
  entrar(jugador) {
    $("sesion_jugador").textContent = `Jugador ${jugador}`;
    this.jugador = jugador;
    this.d.logros.cargar(jugador).then((datos) => this.d.logros.pintarRacha($("sesion_racha"), datos)).catch(() => {});
    this.pausar(false, { enviar: false });
    if (this.encuadreHecho) { this._elegirEjercicio(); return; }
    this.etapa = "tutorial";
    this.d.tutorial(jugador).then(() => { if (this.etapa === "tutorial") this._intro(); });
  }

  /** Nuevo jugador o nuevo personaje: empieza desde el encuadre. */
  reiniciar() { this.encuadreHecho = false; this.calentado = false; }

  salir() {
    this._parar();
    if (this._enActividad()) this.d.enviar("detener");
    sonido.fijarIntensidad(0);
    this.etapa = null;
    this._aviso(null);
  }

  _enActividad() { return this.etapa === "rango" || this.etapa === "juego"; }

  // --- temporizadores -------------------------------------------------------------
  /** Cuenta de `desde` a 0 (un segundo cada número) y luego llama a `alFin`. Se congela en pausa. */
  _cuenta(desde, alTick, alFin) {
    this._parar();
    let quedan = desde;
    alTick?.(quedan);
    this._t = setInterval(() => {
      if (this.pausado) return;
      quedan -= 1;
      if (quedan < 0) { this._parar(); alFin(); } else alTick?.(quedan);
    }, 1000);
  }

  _parar() { clearInterval(this._t); this._t = null; }

  _numero(n, clase = "") {
    const c = $("paso_cuenta");
    if (n === "ok") {
      c.replaceChildren(Object.assign(document.createElement("span"), { className: "icono", ariaHidden: "true" }));
      c.firstChild.dataset.icono = "marca";
    } else c.textContent = n;
    c.className = "cuenta";
    void c.offsetWidth; // reinicia la animación
    c.className = `cuenta latido ${clase}`;
    sonido.efecto(n === 0 ? "ya" : "cuenta");
  }

  // --- tarjeta de cada paso ----------------------------------------------------------
  _tarjeta({ etiqueta = "", titulo, texto = "", modo = "centro", cuenta = false, barra = false, ejercicios = false, botones = [], estrellas = null }) {
    const t = $("tarjeta_paso");
    t.className = `tarjeta-paso ${modo}${ejercicios ? " lista" : ""}`;
    $("paso_etiqueta").textContent = etiqueta;
    $("paso_titulo").textContent = titulo;
    $("paso_texto").textContent = texto;
    voz.decir([titulo, texto].filter(Boolean).join(/[.!?…]$/.test(titulo) ? " " : ". "));
    $("paso_cuenta").classList.toggle("oculto", !cuenta);
    $("paso_barra").classList.toggle("oculto", !barra);
    this._estrellas(estrellas);
    $("paso_progreso").style.width = "0";
    $("paso_lado").classList.toggle("oculto", !ejercicios);
    $("paso_ejercicios").classList.toggle("oculto", !ejercicios);
    $("paso_botones").replaceChildren(...botones.map(({ texto: rotulo, accion, primario, id }) => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: rotulo });
      if (primario) b.className = "primario";
      if (id) b.id = id;
      b.addEventListener("click", () => { this._parar(); accion(); });
      return b;
    }));
  }

  /** De 0 a 3 estrellas que aparecen una tras otra, cada una con su sonido. null las oculta. */
  _estrellas(cuantas) {
    const caja = $("paso_estrellas");
    caja.classList.toggle("oculto", cuantas == null);
    if (cuantas == null) return;
    caja.setAttribute("aria-label", `${cuantas} de 3 estrellas`);
    caja.replaceChildren(...[0, 1, 2].map((i) => {
      const e = Object.assign(document.createElement("span"), { className: `estrella${i < cuantas ? " ganada" : ""}` });
      e.style.animationDelay = `${0.35 + i * 0.3}s`;
      if (i < cuantas) sonido.efecto(i === 2 ? "perfecto" : "bien", 0.35 + i * 0.3);
      return e;
    }));
  }

  _ocultarTarjeta() { $("tarjeta_paso").className = "tarjeta-paso oculto"; }

  _marcarPaso(paso) {
    const orden = ["encuadre", "ejercicio", "rango", "juego"];
    const i = orden.indexOf(paso);
    for (const li of $("pasos_sesion").children) {
      const j = orden.indexOf(li.dataset.paso);
      li.className = j < i ? "hecho" : j === i ? "actual" : "";
    }
  }

  /** Un botón que se pulsa solo al terminar la cuenta (el jugador no necesita acercarse). */
  _autoBoton(id, rotulo, segundos, accion) {
    this._cuenta(segundos, (n) => { const b = $(id); if (b) b.textContent = `${rotulo} (${n})`; }, accion);
  }

  // --- 1. encuadre ----------------------------------------------------------------------
  _intro() {
    this.etapa = "intro";
    this._marcarPaso("encuadre");
    $("juego_hud").classList.add("oculto");
    this._tarjeta({
      etiqueta: "Paso 1 · Calibrar",
      titulo: "¡Bien! Ahora pasaremos a calibrar",
      texto: "Ponte de pie frente a la cámara, a 2 o 3 metros, con todo tu cuerpo a la vista: de la cabeza a los pies.",
      cuenta: true,
    });
    this._cuenta(SEGUNDOS.intro, (n) => this._numero(n), () => (this.calentado ? this._encuadre() : this._calentamiento(0)));
  }

  /** Calentamiento guiado: la guía hace cada movimiento suave unos segundos; se puede saltar. */
  _calentamiento(i) {
    if (i >= CALENTAMIENTO.length) {
      this.calentado = true;
      this.d.demostrar({ articulacion: "rodilla", sentido: 1, objetivo: 0 });
      sonido.fijarIntensidad(0);
      this._encuadre();
      return;
    }
    this.etapa = "calentamiento";
    const paso = CALENTAMIENTO[i];
    this.d.demostrar({ ...paso, lado: this.lado, tiempo_sostenido_ms: 300 });
    sonido.fijarIntensidad(0.6);
    this._tarjeta({
      etiqueta: `Calentamiento · ${i + 1} de ${CALENTAMIENTO.length}`,
      titulo: paso.titulo,
      texto: "Imita a la guía con movimientos suaves, sin forzar.",
      modo: "arriba", cuenta: true, barra: true,
      botones: [{ texto: "Saltar calentamiento", accion: () => this._calentamiento(CALENTAMIENTO.length) }],
    });
    const inicio = performance.now();
    this._cuenta(SEGUNDOS_POR_CALENTAMIENTO, (n) => {
      this._numero(n);
      $("paso_progreso").style.width = `${Math.min(100, ((performance.now() - inicio) / 10) / SEGUNDOS_POR_CALENTAMIENTO)}%`;
    }, () => this._calentamiento(i + 1));
  }

  _encuadre() {
    this.etapa = "encuadre";
    this._okDesde = null;
    this._tarjeta({
      etiqueta: "Paso 1 · Calibrar",
      titulo: "Quédate quieto",
      texto: "Estoy revisando que se vea todo tu cuerpo…",
      modo: "arriba", cuenta: true, barra: true,
    });
    this._numero(SEGUNDOS.encuadre);
  }

  _fotogramaEncuadre(msg) {
    const ok = msg.persona && msg.encuadre_ok;
    const ahora = performance.now();
    if (!ok) {
      this._okDesde = null;
      $("paso_progreso").style.width = "0";
      $("paso_texto").textContent = "Aún no te veo completo. Aléjate un poco de la cámara.";
      this._aviso(this.d.textoAviso(msg));
      return;
    }
    this._aviso(null);
    this._okDesde ??= ahora;
    const transcurrido = (ahora - this._okDesde) / 1000;
    $("paso_texto").textContent = "¡Te veo completo! No te muevas…";
    $("paso_progreso").style.width = `${Math.min(100, (100 * transcurrido) / SEGUNDOS.encuadre)}%`;
    const quedan = Math.max(0, Math.ceil(SEGUNDOS.encuadre - transcurrido));
    if (String(quedan) !== $("paso_cuenta").textContent) this._numero(quedan);
    if (transcurrido >= SEGUNDOS.encuadre) this._calibrado();
  }

  _calibrado() {
    this.etapa = "calibrado";
    this.encuadreHecho = true;
    this._tarjeta({ etiqueta: "Paso 1 · Calibrar", titulo: "¡Calibrado!", texto: "Ya te veo de cuerpo completo. Ahora elige tu ejercicio.", cuenta: true });
    this._numero("ok", "listo");
    this._celebrar("¡CALIBRADO!", "serie");
    this._cuenta(SEGUNDOS.calibrado, null, () => this._elegirEjercicio());
  }

  // --- 2. elegir ejercicio -----------------------------------------------------------------
  _elegirEjercicio() {
    this.etapa = "ejercicio";
    this._parar();
    this._aviso(null);
    this._marcarPaso("ejercicio");
    $("juego_hud").classList.add("oculto");
    this._tarjeta({
      etiqueta: "Paso 2 · Ejercicio",
      titulo: "Selecciona el ejercicio",
      texto: "Elige la pierna y luego el ejercicio. El juego se adapta a tu rango de movimiento.",
      ejercicios: true,
    });
    this._pintarEjercicios();
  }

  _pintarEjercicios() {
    for (const b of $("paso_lado").querySelectorAll("[data-lado]")) {
      b.setAttribute("aria-checked", String(b.dataset.lado === this.lado));
    }
    const progreso = this.d.progreso();
    $("paso_ejercicios").replaceChildren(...Object.values(this.d.ejercicios()).map((e) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "tarjeta-ejercicio" });
      const serie = progreso.find((s) => s.ejercicio === e.clave && s.lado === this.lado);
      const datos = Object.assign(document.createElement("div"), { className: "datos" });
      const dato = (texto, clase = "") => Object.assign(document.createElement("span"), { className: `dato ${clase}`, textContent: texto });
      datos.append(dato(POSICION[e.posicion]),
        dato(e.direccion === "arriba" ? `Normal: hasta ${e.max_fisiologico}°` : "Normal: pierna recta (0°)"));
      if (serie) datos.append(dato(`Tu último rango: ${Math.round(serie.ultimo.mejor)}°`, "tuyo"));
      const insignia = Object.assign(document.createElement("span"), { className: "insignia" });
      insignia.append(Object.assign(document.createElement("span"), { className: "icono", ariaHidden: "true" }));
      insignia.firstChild.dataset.icono = `ej-${e.clave}`;
      b.append(insignia, Object.assign(document.createElement("strong"), { textContent: e.nombre }),
        Object.assign(document.createElement("span"), { textContent: e.descripcion }), datos);
      b.addEventListener("click", () => this._previaRango(e.clave));
      return b;
    }));
  }

  // --- 3. calibrar el rango del ejercicio ------------------------------------------------------
  _previaRango(clave) {
    this.clave = clave;
    this.plan = null;
    this.etapa = "previa";
    this._marcarPaso("rango");
    this.d.elegirEjercicio(clave, this.lado); // la guía demuestra el rango normal mientras tanto
    const r = this.regla;
    this._tarjeta({
      etiqueta: "Paso 3 · Tu rango",
      titulo: `Calibrando rangos de movimiento para «${r.nombre}»`,
      texto: `Ponte de lado, con tu pierna ${LADOS[this.lado]} hacia la cámara, ${r.posicion_inicial}. ` +
        (r.posicion === "sentado" ? "Pon la silla de perfil a la cámara y mira al frente, no a la pantalla. " : "") +
        "Primero quédate quieto; luego haz el movimiento lo más que puedas 3 veces, sin dolor. La guía te muestra cómo.",
      cuenta: true,
    });
    this._cuenta(SEGUNDOS.rango, (n) => this._numero(n), () => this._calibrarRango());
  }

  _calibrarRango() {
    this.etapa = "rango";
    sonido.fijarIntensidad(0.3);
    this._pasoGuia = null;
    this._tarjeta({ etiqueta: "Paso 3 · Tu rango", titulo: this.regla.nombre, texto: `Ponte de lado, ${this.regla.posicion_inicial}…`, modo: "arriba", barra: true });
    this.d.enviar("calibrar", { ejercicio: this.clave, lado: this.lado });
  }

  _fotogramaRango(msg) {
    const c = msg.calibracion;
    this._avisoDeFotograma(msg, c);
    if (!c) return;
    $("paso_progreso").style.width = `${c.progreso * 100}%`;
    // En el reposo la guía queda quieta: si se mueve, el jugador tiende a imitarla y empieza doblado.
    const pasoGuia = c.fase === "verificando_vista" || c.paso === "reposo" ? "inicial" : "normal";
    if (this._pasoGuia !== pasoGuia) {
      this._pasoGuia = pasoGuia;
      this.d.mostrarGuia(pasoGuia);
    }
    const angulo = c.angulo == null ? "" : ` · ahora ${c.angulo.toFixed(0)}°`;
    const inicial = this.regla.posicion_inicial;
    let titulo, texto;
    if (c.fase === "verificando_vista") {
      titulo = "Ponte de lado";
      texto = `Con tu pierna ${LADOS[c.lado ?? this.lado]} hacia la cámara, ${inicial}.`;
      if (this.regla.posicion === "sentado") texto += " Mira al frente, no a la pantalla.";
    } else if (c.fase === "pausado") {
      titulo = "En pausa";
      texto = "Pulsa «Reanudar» cuando estés listo.";
    } else if (c.paso === "reposo") {
      titulo = "Quédate quieto";
      texto = `${inicial[0].toUpperCase()}${inicial.slice(1)}${angulo}`;
    } else {
      const n = Math.min(c.intentos + 1, c.intentos_necesarios);
      titulo = `Intento ${n} de ${c.intentos_necesarios}`;
      const hechos = c.picos.length ? ` · tus intentos: ${c.picos.map((p) => `${p.toFixed(0)}°`).join(", ")}` : "";
      texto = c.en_intento
        ? `¡Más! Mantén el máximo un momento${c.pico_actual == null ? "" : ` (${c.pico_actual.toFixed(0)}°)`}`
        : `Haz el movimiento lo más que puedas, sin dolor${hechos}`;
    }
    $("paso_titulo").textContent = titulo;
    $("paso_texto").textContent = texto;
  }

  async _rangoListo(r) {
    this.etapa = "rango_listo";
    this._pasoGuia = null;
    this._tarjeta({ etiqueta: "Paso 3 · Tu rango", titulo: "Guardando tu rango…", cuenta: true });
    this._numero("ok", "listo");
    if (!(await this.d.guardarResumen(r))) {
      this._tarjeta({
        etiqueta: "Paso 3 · Tu rango", titulo: "No pude guardar tu calibración",
        texto: "Revisa que el servicio siga encendido.",
        botones: [{ texto: "Reintentar", primario: true, accion: () => this._previaRango(this.clave) },
          { texto: "Otro ejercicio", accion: () => this._elegirEjercicio() }],
      });
      return;
    }
    this._celebrar("¡CALIBRADO!", "serie");
    const plan = this.plan = await this.d.cargarPlan();
    const variaron = r.consistente ? "" : " Tus intentos variaron mucho; la meta es prudente.";
    if (!plan || plan.requiere_calibracion || !plan.jugable) {
      this._tarjeta({
        etiqueta: "Paso 3 · Tu rango", titulo: "Calibrado",
        texto: `Tu rango hoy: de ${r.reposo}° a ${r.mejor}°. Es muy pequeño para contar repeticiones con fiabilidad; coméntalo con tu fisioterapeuta.`,
        botones: [{ texto: "Otro ejercicio", primario: true, accion: () => this._elegirEjercicio() },
          { texto: "Volver a calibrar", accion: () => this._previaRango(this.clave) }],
      });
      return;
    }
    const origen = plan.origen === "fisioterapeuta" ? "fijada por tu fisioterapeuta"
      : `el ${Math.round(100 * plan.fraccion_rango)} % de tu rango${plan.ajuste ? `, ${plan.ajuste > 0 ? "+" : ""}${plan.ajuste}° por cómo te ha ido` : ""}`;
    this._tarjeta({
      etiqueta: "Paso 3 · Tu rango", titulo: "¡Calibrado!",
      texto: `Tu rango hoy: de ${r.reposo}° a ${r.mejor}° (normal: ${plan.referencia}°). ` +
        `Tu meta: ${plan.meta}°, ${origen}. ${plan.repeticiones} repeticiones.${variaron}`,
      cuenta: true,
    });
    this._numero("ok", "listo");
    this._cuenta(SEGUNDOS.calibrado + 1, null, () => this._preparate());
  }

  _falloCalibracion(motivo) {
    this.etapa = "fallo";
    this._pasoGuia = null;
    this.d.mostrarGuia("normal");
    const porque = motivo === "sin_reposo"
      ? "no pudiste quedarte quieto en la posición inicial (o no se vio bien la pierna)"
      : "no se registró ningún intento completo";
    this._tarjeta({
      etiqueta: "Paso 3 · Tu rango", titulo: "No pude calibrar",
      texto: `Parece que ${porque}. Revisa la luz y que tu pierna se vea de lado.`,
      botones: [{ texto: "Reintentar", primario: true, id: "btn_auto", accion: () => this._previaRango(this.clave) },
        { texto: "Otro ejercicio", accion: () => this._elegirEjercicio() }],
    });
    this._autoBoton("btn_auto", "Reintentar", SEGUNDOS.reintento, () => this._previaRango(this.clave));
  }

  // --- 4. jugar ----------------------------------------------------------------------------------
  _preparate() {
    this.etapa = "preparate";
    this._marcarPaso("juego");
    $("juego_hud").classList.add("oculto");
    this.d.mostrarGuia("meta"); // la guía ya muestra la meta adaptada del jugador
    const r = this.regla;
    this._tarjeta({
      etiqueta: "Paso 4 · ¡A jugar!",
      titulo: "Prepárate para iniciar",
      texto: `Meta: ${this.plan.meta}° · ${this.plan.repeticiones} repeticiones. Ponte de lado, ${r.posicion_inicial}.`,
      cuenta: true,
    });
    this._cuenta(SEGUNDOS.preparate, (n) => this._numero(n, n === 0 ? "listo" : ""), () => this._jugar());
  }

  _jugar() {
    this.etapa = "juego";
    this._ocultarTarjeta();
    this._celebrar("¡YA!", "perfecto");
    const p = this.plan;
    $("sesion_reps").textContent = "0";
    $("sesion_reps_meta").textContent = p.repeticiones;
    $("sesion_pips").replaceChildren(...Array.from({ length: p.repeticiones }, () =>
      Object.assign(document.createElement("span"), { className: "pip" })));
    $("ejecucion_relleno").style.width = "0";
    $("ejecucion_meta").style.left = `${META_EN_BARRA * 100}%`;
    $("ejecucion_meta_texto").textContent = `Meta ${p.meta}°`;
    $("sesion_estado").textContent = "Ponte de lado";
    $("juego_hud").classList.remove("oculto");
    sonido.fijarIntensidad(0.45);
    this.d.enviar("iniciar_ejercicio", {
      ejercicio: this.clave, lado: this.lado, meta: p.meta, repeticiones: p.repeticiones,
      tiempo_sostenido_ms: p.tiempo_sostenido_ms, reposo: p.reposo,
    });
  }

  _fotogramaJuego(msg) {
    const rep = msg.rep;
    this._avisoDeFotograma(msg, rep);
    if (!rep) return;
    // La barra va del reposo del jugador (0 %) a su meta (80 %): se adapta a su rango, no al normal.
    const signo = rep.direccion === "arriba" ? 1 : -1;
    const inicio = this.plan.reposo ?? (signo === 1 ? 0 : 90);
    const tramo = Math.max(1, signo * (rep.umbral_meta - inicio));
    const fraccion = rep.angulo == null ? 0 : (signo * (rep.angulo - inicio)) / tramo;
    const enMeta = rep.estado === "en_objetivo" || rep.estado === "bajando";
    // La música sube mientras se mueve y baja en reposo.
    sonido.fijarIntensidad(rep.fase === "midiendo" && rep.estado !== "reposo" && rep.estado !== "preparacion" ? 1 : 0.45);
    $("ejecucion_relleno").style.width = `${Math.max(0, Math.min(1, fraccion * META_EN_BARRA)) * 100}%`;
    $("ejecucion_relleno").classList.toggle("en_objetivo", enMeta);
    $("sosten_relleno").style.width = rep.estado === "en_objetivo" && rep.tiempo_sostenido_ms > 0
      ? `${Math.min(100, (100 * rep.sostenido_ms) / rep.tiempo_sostenido_ms)}%` : "0";
    $("sesion_reps").textContent = rep.validas;
    $("sesion_angulo").textContent = rep.angulo == null ? "–" : `${Math.round(rep.angulo)}°`;
    let texto = rep.fase === "midiendo" ? ESTADOS[rep.estado] ?? rep.estado : FASES[rep.fase] ?? rep.fase;
    if (rep.fase === "midiendo" && rep.estado === "en_objetivo" && rep.tiempo_sostenido_ms > 0) {
      texto += ` ${(rep.sostenido_ms / 1000).toFixed(1)} / ${(rep.tiempo_sostenido_ms / 1000).toFixed(1)} s`;
    }
    if (performance.now() > this._estadoHasta) $("sesion_estado").textContent = texto;
  }

  async _finSerie(nombre, r) {
    const mostrar = this.etapa === "juego";
    if (mostrar) this.etapa = "resultado";
    sonido.fijarIntensidad(0);
    $("juego_hud").classList.add("oculto");
    // Una calibración interrumpida no mide el rango, pero su tiempo sí cuenta como jugado.
    const guardar = (r.tipo === "juego" && r.mejor != null) || (r.tipo === "calibracion" && r.duracion_s > 0);
    const metaAnterior = r.meta;
    const guardado = guardar ? await this.d.guardarResumen(r) : false;
    if (!mostrar) return;
    if (guardado) {
      this.plan = await this.d.cargarPlan();
      this.d.logros.revisar(this.jugador); // racha del día y logros nuevos
    }
    if (nombre === "serie_completa") this._celebrar("¡SERIE COMPLETA!", "serie");
    // Estrellas: 3 si todas contaron y todas pasaron la meta, 2 si contó al menos el 70 %, 1 si terminó.
    const perfectas = $("sesion_pips").querySelectorAll(".pip.perfecto").length;
    const estrellas = nombre !== "serie_completa" ? null
      : r.validas === r.intentadas && perfectas >= r.validas ? 3 : r.validas / r.intentadas >= 0.7 ? 2 : 1;
    const pideOpinion = guardado && await this.d.encuesta.pendiente(this.jugador).catch(() => false);
    const nueva = this.plan?.meta;
    const sube = this.plan && (this.plan.direccion === "arriba" ? nueva > metaAnterior : nueva < metaAnterior);
    const cambio = !guardado || nueva == null || nueva === metaAnterior ? ""
      : ` Tu próxima meta: ${nueva}° (${sube ? "sube" : "baja"} según cómo te fue).`;
    this._tarjeta({
      etiqueta: "Paso 4 · Resultado",
      titulo: nombre === "serie_completa" ? ["", "¡Serie completa!", "¡Muy bien!", "¡Excelente!"][estrellas] : "Ejercicio detenido",
      estrellas,
      texto: (r.mejor == null ? "No hubo medidas para guardar." : `${r.validas} de ${r.intentadas} repeticiones válidas · tu mejor: ${r.mejor}°.`) + cambio,
      botones: [{ texto: "Otro ejercicio", primario: true, id: "btn_auto", accion: () => this._elegirEjercicio() },
        ...(this.plan?.jugable ? [{ texto: "Repetir", accion: () => this._preparate() }] : []),
        ...(pideOpinion ? [{ texto: "Danos tu opinión (1 min)", accion: async () => {
          await this.d.encuesta.abrir(this.jugador);
          this._elegirEjercicio();
        } }] : []),
        { texto: "Ver mi progreso", accion: () => this.d.irA("progreso") },
        { texto: "Terminar", accion: () => this.d.irA("menu") }],
    });
    this._autoBoton("btn_auto", "Otro ejercicio", SEGUNDOS.otro, () => this._elegirEjercicio());
  }

  // --- controles -----------------------------------------------------------------------------------
  pausar(si, { enviar = true } = {}) {
    this.pausado = si;
    $("btn_sesion_pausa").textContent = si ? "Reanudar" : "Pausar";
    if (enviar && this._enActividad()) this.d.enviar(si ? "pausar" : "reanudar");
  }

  detener() {
    voz.callar();
    sonido.fijarIntensidad(0);
    this._parar();
    if (this._enActividad()) this.d.enviar("detener");
    this.pausar(false, { enviar: false });
    this.etapa = "detenido";
    this._pasoGuia = null;
    $("juego_hud").classList.add("oculto");
    this._aviso(null);
    this._tarjeta({
      etiqueta: "Detenido",
      titulo: "Descansa un momento",
      texto: "Si sentiste dolor o malestar, no sigas y coméntalo con tu fisioterapeuta.",
      botones: [{ texto: "Elegir ejercicio", primario: true, accion: () => this._elegirEjercicio() },
        { texto: "Volver al menú", accion: () => this.d.irA("menu") }],
    });
  }

  // --- mensajes del servicio -------------------------------------------------------------------------
  fotograma(msg) {
    this.d.dibujar(msg, $("lienzo_sesion"));
    if (this.etapa === "encuadre") this._fotogramaEncuadre(msg);
    else if (this.etapa === "rango") this._fotogramaRango(msg);
    else if (this.etapa === "juego") this._fotogramaJuego(msg);
    else if (performance.now() > this._avisoHasta) this._aviso(null);
  }

  evento(msg) {
    switch (msg.nombre) {
      case "comando_rechazado":
        this._avisoTemporal(`No se pudo: ${msg.motivo}`);
        break;
      case "fuera_de_rango":
        this._avisoTemporal(msg.mensaje);
        break;
      case "vista_ok":
        this._celebrar("¡TE VEO!", "bien");
        break;
      case "intento_calibracion":
        if (this.etapa === "rango") this._celebrar(`${Math.round(msg.angulo_pico)}°`, "bien");
        break;
      case "calibracion_fallida":
        if (msg.resumen?.duracion_s > 0) this.d.guardarResumen(msg.resumen); // no mide rango, pero fue tiempo jugado
        if (this.etapa === "rango") this._falloCalibracion(msg.motivo);
        break;
      case "calibracion_lista":
        if (this.etapa === "rango") this._rangoListo(msg.resumen);
        break;
      case "rep_valida": {
        this._celebrar(...CELEBRACION[msg.calidad]);
        const pip = $("sesion_pips").querySelector(".pip:not(.perfecto, .bien)");
        if (pip) pip.className = `pip ${msg.calidad} nuevo`;
        break;
      }
      case "rep_incompleta": {
        this._celebrar(...CELEBRACION[msg.calidad]);
        const hud = $("juego_hud"); // un temblor corto: esta no contó
        hud.classList.remove("fallo");
        void hud.offsetWidth;
        hud.classList.add("fallo");
        $("sesion_estado").textContent = `${msg.calidad === "casi" ? "Casi" : "Esta no contó"}: ${MOTIVOS_REP[msg.motivo] ?? msg.motivo}. ¡Sigue!`;
        voz.decir(`${msg.calidad === "casi" ? "Casi" : "Esta no contó"}: ${MOTIVOS_REP[msg.motivo] ?? ""}`);
        this._estadoHasta = performance.now() + 2000;
        break;
      }
      case "serie_completa":
      case "ejercicio_detenido":
        this._finSerie(msg.nombre, msg.resumen);
        break;
    }
  }

  _avisoDeFotograma(msg, actividad) {
    if (performance.now() < this._avisoHasta) return; // se está mostrando un aviso de un evento
    let texto = null;
    if (!msg.encuadre_ok) texto = this.d.textoAviso(msg);
    else if (actividad?.fase === "verificando_vista") {
      const sentado = this.regla.posicion === "sentado";
      if (!msg.vista?.lateral) {
        texto = sentado ? "Gira la silla: la cámara debe verte de perfil, con el pecho hacia un lado"
          : `Ponte de lado, con tu pierna ${LADOS[this.lado]} hacia la cámara`;
      } else if (msg.vista.lado_camara !== this.lado) {
        texto = `Gírate: la cámara debe ver tu pierna ${LADOS[this.lado]}`;
      } else if (sentado && !msg.vista.muslo_horizontal) {
        texto = "Siéntate con el muslo horizontal y que se vea toda la pierna";
      }
    } else if (actividad?.compensacion) texto = actividad.compensacion;
    this._aviso(texto);
  }

  _aviso(texto) {
    $("aviso_sesion").classList.toggle("oculto", !texto);
    if (texto && texto !== $("aviso_sesion").dataset.dicho) voz.decir(texto, { interrumpir: false });
    $("aviso_sesion").dataset.dicho = texto ?? "";
    if (texto) $("aviso_sesion").textContent = texto;
  }

  _avisoTemporal(texto) {
    this._aviso(texto);
    this._avisoHasta = performance.now() + 4000;
  }

  _celebrar(texto, clase) {
    for (const [id, base] of [["celebracion_sesion", "celebracion"], ["destello_sesion", "destello"]]) {
      const el = $(id);
      el.className = base;
      void el.offsetWidth; // reinicia la animación aunque la clase sea la misma
      el.className = `${base} ${clase} ver`;
    }
    $("celebracion_sesion").textContent = texto;
  }
}
