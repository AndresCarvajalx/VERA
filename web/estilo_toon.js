// Estilo de caricatura para los personajes: sombreado por bandas (cel shading) y un contorno oscuro,
// como en los videojuegos animados. Con figuras hechas de formas simples es lo que más las hace
// verse terminadas: las sombras dejan de ser degradados de plástico y la silueta se lee clara.
import * as THREE from "./vendor/three.module.min.js";

const GROSOR_CONTORNO = 0.011; // en unidades del modelo (metros antes de escalarlo)
const COLOR_CONTORNO = 0x1a0d2e;

let rampa = null;
/** Tres bandas de luz: sombra, medio tono y luz. */
function rampaDeLuz() {
  if (rampa) return rampa;
  rampa = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1);
  rampa.minFilter = rampa.magFilter = THREE.NearestFilter;
  rampa.needsUpdate = true;
  return rampa;
}

let materialContorno = null;
/** Material del contorno: dibuja solo las caras de atrás, infladas a lo largo de su normal. */
function contorno() {
  if (materialContorno) return materialContorno;
  materialContorno = new THREE.MeshBasicMaterial({ color: COLOR_CONTORNO, side: THREE.BackSide });
  materialContorno.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <skinning_vertex>",
      `#include <skinning_vertex>\n  transformed += normalize(objectNormal) * ${GROSOR_CONTORNO.toFixed(4)};`);
  };
  return materialContorno;
}

/** Pasa un material del modelo (glTF, estándar) a caricatura, conservando su nombre, color y brillo. */
function aCaricatura(original) {
  const toon = new THREE.MeshToonMaterial({
    name: original.name, color: original.color.clone(), map: original.map ?? null, gradientMap: rampaDeLuz(),
    emissive: original.emissive.clone(), emissiveIntensity: original.emissiveIntensity, emissiveMap: original.emissiveMap ?? null,
    transparent: original.transparent, opacity: original.opacity,
  });
  toon.userData = original.userData;
  return toon;
}

/**
 * Aplica el estilo a todas las mallas del modelo. Llamar antes de guardar referencias a sus materiales.
 * @param {THREE.Object3D} modelo
 */
export function estiloCaricatura(modelo) {
  const mallas = [];
  modelo.traverse((o) => { if (o.isMesh) mallas.push(o); });
  for (const o of mallas) {
    o.material = aCaricatura(o.material);
    if (!o.isSkinnedMesh) continue;
    // El contorno es hijo de la malla: se mueve con el mismo esqueleto y se oculta junto con ella.
    const borde = new THREE.SkinnedMesh(o.geometry, contorno());
    borde.bind(o.skeleton, o.bindMatrix);
    borde.frustumCulled = false;
    borde.name = `${o.name}_contorno`;
    borde.userData.contorno = true;
    o.add(borde);
  }
}
