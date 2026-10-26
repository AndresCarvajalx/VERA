// Avatar guía (CU-06): genera, sin cámara, la pose del ejercicio de referencia para un
// instante dado. Parte de una pose de reposo (de pie o sentado) y rota la cadena de la
// pierna en el plano sagital, que es el plano que mide el ejercicio.
import * as THREE from "./vendor/three.module.min.js";
import { P } from "./avatar.js";

// Pose de reposo de pie, en metros y en coordenadas de la escena (y arriba, z hacia la
// cámara, lado derecho del jugador en x positiva porque la vista es en espejo).
function poseDePie() {
  const pts = Array.from({ length: 33 }, () => new THREE.Vector3(0, 1.0, 0));
  const lados = { Izq: -1, Der: 1 };
  for (const [lado, s] of Object.entries(lados)) {
    pts[P[`oreja${lado}`]].set(0.07 * s, 1.62, 0);
    pts[P[`hombro${lado}`]].set(0.18 * s, 1.45, 0);
    pts[P[`codo${lado}`]].set(0.22 * s, 1.18, 0);
    pts[P[`muneca${lado}`]].set(0.24 * s, 0.93, 0.02);
    pts[P[`cadera${lado}`]].set(0.1 * s, 0.95, 0);
    pts[P[`rodilla${lado}`]].set(0.1 * s, 0.52, 0.01);
    pts[P[`tobillo${lado}`]].set(0.1 * s, 0.1, 0);
    pts[P[`talon${lado}`]].set(0.1 * s, 0.03, -0.05);
    pts[P[`pie${lado}`]].set(0.1 * s, 0.02, 0.14);
  }
  return pts;
}

// Sentado en una silla de 0.48 m: cadera y rodilla a 90°, pies apoyados.
function poseSentado() {
  const pts = poseDePie();
  for (const [lado, s] of Object.entries({ Izq: -1, Der: 1 })) {
    for (const parte of ["oreja", "hombro", "codo", "muneca"]) pts[P[`${parte}${lado}`]].y -= 0.45;
    pts[P[`muneca${lado}`]].z = 0.25;
    pts[P[`cadera${lado}`]].set(0.1 * s, 0.5, 0);
    pts[P[`rodilla${lado}`]].set(0.1 * s, 0.5, 0.43);
    pts[P[`tobillo${lado}`]].set(0.1 * s, 0.1, 0.43);
    pts[P[`talon${lado}`]].set(0.1 * s, 0.03, 0.38);
    pts[P[`pie${lado}`]].set(0.1 * s, 0.02, 0.57);
  }
  return pts;
}

const EJE_X = new THREE.Vector3(1, 0, 0);

function rotar(pts, pivote, indices, grados) {
  const q = new THREE.Quaternion().setFromAxisAngle(EJE_X, THREE.MathUtils.degToRad(grados));
  const centro = pts[pivote].clone();
  for (const i of indices) pts[i].sub(centro).applyQuaternion(q).add(centro);
}

/**
 * Pose del avatar guía con la articulación movida `grados` desde la neutra.
 * Signo de la rotación alrededor de +x: positivo lleva un segmento que cuelga hacia atrás.
 */
export function poseGuia({ articulacion, lado, sentido }, grados) {
  const L = lado === "izq" ? "Izq" : "Der";
  const cadera = P[`cadera${L}`], rodilla = P[`rodilla${L}`], tobillo = P[`tobillo${L}`];
  const pie = [P[`talon${L}`], P[`pie${L}`]];
  // Extender la rodilla se practica sentado (de pie ya está extendida).
  const sentado = articulacion === "rodilla" && sentido === -1;
  const pts = sentado ? poseSentado() : poseDePie();

  if (articulacion === "rodilla") {
    // De pie: flexión lleva el talón hacia atrás. Sentado: extensión lleva el pie hacia adelante.
    rotar(pts, rodilla, [tobillo, ...pie], sentido === 1 ? grados : -grados);
  } else if (articulacion === "cadera") {
    // Flexión: la rodilla sube hacia adelante con la pierna colgando (como al marchar); doblar
    // la rodilla no cambia el ángulo de cadera que se mide. Extensión: la pierna va hacia atrás.
    rotar(pts, cadera, [rodilla, tobillo, ...pie], sentido === 1 ? -grados : grados);
    if (sentido === 1) rotar(pts, rodilla, [tobillo, ...pie], grados);
  } else if (articulacion === "tobillo") {
    // Dorsiflexión: la punta del pie sube. Plantiflexión: baja. Se levanta un poco el pie del piso.
    rotar(pts, cadera, [rodilla, tobillo, ...pie], -15);
    rotar(pts, tobillo, pie, sentido === 1 ? -grados : grados);
  }
  return { pts, sentado };
}

/**
 * Ciclo de una repetición de referencia: sube (1 s), sostiene, baja (1 s) y descansa (0.8 s).
 * Devuelve los grados en el instante `t` (ms) y la fase, para mostrarla en pantalla.
 */
export function cicloGuia(t, objetivo, sostenerMs) {
  const SUBIR = 1000, BAJAR = 1000, DESCANSO = 800;
  const total = SUBIR + sostenerMs + BAJAR + DESCANSO;
  const u = t % total;
  const suave = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x); // acelera y frena como un movimiento real
  if (u < SUBIR) return { grados: objetivo * suave(u / SUBIR), fase: "sube" };
  if (u < SUBIR + sostenerMs) return { grados: objetivo, fase: "sostén" };
  if (u < SUBIR + sostenerMs + BAJAR) return { grados: objetivo * (1 - suave((u - SUBIR - sostenerMs) / BAJAR)), fase: "baja" };
  return { grados: 0, fase: "descansa" };
}
