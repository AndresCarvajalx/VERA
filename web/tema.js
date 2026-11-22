// Tema de la interfaz: el actual ("neon", por defecto) o el profesional. Se elige en Ajustes.
//
// El tema es el atributo data-tema de <html>; el CSS no depende de este archivo: sin JavaScript se
// ve el tema actual. La elección se guarda en este navegador y un script en línea en <head> la
// aplica antes de pintar, para que la página no parpadee con el otro tema al cargar.
const CLAVE = "tema";
const POR_DEFECTO = "neon";
const TEMAS = new Set([POR_DEFECTO, "profesional"]);

export function temaActual() {
  return document.documentElement.dataset.tema === "profesional" ? "profesional" : POR_DEFECTO;
}

function poner(tema) {
  if (tema === POR_DEFECTO) delete document.documentElement.dataset.tema;
  else document.documentElement.dataset.tema = tema;
  // El profesional sigue el modo claro u oscuro del sistema; el actual es siempre oscuro.
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", tema === POR_DEFECTO ? "dark" : "light dark");
  for (const radio of document.querySelectorAll('input[name="tema"]')) radio.checked = radio.value === tema;
  document.dispatchEvent(new CustomEvent("tema", { detail: tema }));
}

/** Cambia de tema con un fundido (si el navegador lo permite y el usuario no pidió menos movimiento). */
export function aplicarTema(tema, { guardar = true } = {}) {
  if (!TEMAS.has(tema)) tema = POR_DEFECTO;
  if (guardar) {
    try {
      if (tema === POR_DEFECTO) localStorage.removeItem(CLAVE); // el valor por defecto no se guarda
      else localStorage.setItem(CLAVE, tema);
    } catch { /* sin almacenamiento: el tema se aplica igual, solo no se recuerda */ }
  }
  if (tema === temaActual()) return;
  const sinMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition && !sinMovimiento) document.startViewTransition(() => poner(tema));
  else poner(tema);
}

export function iniciarTema() {
  for (const radio of document.querySelectorAll('input[name="tema"]')) {
    radio.checked = radio.value === temaActual();
    radio.addEventListener("change", () => { if (radio.checked) aplicarTema(radio.value); });
  }
  // Si se cambia en otra pestaña, esta la sigue.
  window.addEventListener("storage", (e) => {
    if (e.key === CLAVE || e.key === null) aplicarTema(e.newValue ?? POR_DEFECTO, { guardar: false });
  });
}
