// Tutorial corto para quien juega por primera vez: cinco tarjetas con lo esencial. Se muestra solo
// la primera vez de cada jugador (en este navegador) y se puede volver a ver desde el Manual.
import { voz } from "./voz.js";

const $ = (id) => document.getElementById(id);

const PASOS = [
  { icono: "camara", titulo: "Ponte de lado",
    texto: "Pon la cámara a la altura de la cadera, a 2 o 3 metros. Ponte de lado, con la pierna que vas a mover hacia la cámara." },
  { icono: "sonido", titulo: "Imita a la guía",
    texto: "La figura de luz te muestra cómo se hace cada ejercicio. Tú haz lo que puedas, sin dolor: el juego se adapta a tu rango." },
  { icono: "grafica", titulo: "Llena la barra",
    texto: "La barra de ejecución se llena mientras te mueves. Llega a la línea blanca, que es tu meta, y vuelve a la posición inicial: eso es una repetición." },
  { icono: "medalla", titulo: "Gana estrellas y logros",
    texto: "Cada serie te da de una a tres estrellas. Si juegas varios días seguidos sumas una racha y ganas logros." },
  { icono: "alto", titulo: "Si sientes dolor, detente",
    texto: "El botón Detener siempre está a la vista. VERA es un juego de apoyo: no reemplaza a tu fisioterapeuta." },
];

function icono(nombre) {
  const s = Object.assign(document.createElement("span"), { className: "icono" });
  s.dataset.icono = nombre;
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** Abre el tutorial; la promesa se cumple al cerrarlo (terminado o saltado). */
export function mostrarTutorial() {
  const dialogo = $("dialogo_tutorial");
  let i = 0;
  const pintar = () => {
    const paso = PASOS[i];
    $("tutorial_icono").replaceChildren(icono(paso.icono));
    $("tutorial_titulo").textContent = paso.titulo;
    $("tutorial_texto").textContent = paso.texto;
    $("tutorial_puntos").replaceChildren(...PASOS.map((_, j) => Object.assign(document.createElement("span"), {
      className: j === i ? "activo" : "",
    })));
    $("tutorial_anterior").disabled = i === 0;
    $("tutorial_siguiente").textContent = i === PASOS.length - 1 ? "¡Empezar!" : "Siguiente";
    voz.decir(`${paso.titulo}. ${paso.texto}`);
  };
  const siguiente = () => { if (i === PASOS.length - 1) dialogo.close(); else { i += 1; pintar(); } };
  const anterior = () => { if (i > 0) { i -= 1; pintar(); } };
  const saltar = () => dialogo.close();
  $("tutorial_siguiente").addEventListener("click", siguiente);
  $("tutorial_anterior").addEventListener("click", anterior);
  $("tutorial_saltar").addEventListener("click", saltar);
  pintar();
  dialogo.showModal();
  return new Promise((resolver) => {
    dialogo.addEventListener("close", () => {
      $("tutorial_siguiente").removeEventListener("click", siguiente);
      $("tutorial_anterior").removeEventListener("click", anterior);
      $("tutorial_saltar").removeEventListener("click", saltar);
      voz.callar();
      resolver();
    }, { once: true });
  });
}
