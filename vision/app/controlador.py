"""Controlador de la sesión: atiende comandos del navegador y aplica las reglas ROM.

Comandos (navegador → servicio):
    evaluar_rango     {ejercicio, lado, duracion_ms}
    iniciar_ejercicio {ejercicio, lado, meta, repeticiones, tiempo_sostenido_ms, reposo}
    pausar | reanudar | detener

Eventos (servicio → navegador):
    vista_ok, evaluacion_lista, evaluacion_fallida, rep_valida, rep_incompleta,
    compensacion, fuera_de_rango, serie_completa, ejercicio_detenido, comando_rechazado

Reglas: config/reglas_rom.json (ver docs/reglas_rango_movimiento_miembro_inferior.md).
"""
from dataclasses import dataclass, field

from .reglas import ReglaEjercicio, cargar
from .repeticiones import ContadorRepeticiones

LADOS = ("izq", "der")
VISTA_ESTABLE_MS = 1000  # tiempo de lado y con el lado correcto antes de empezar a medir
DURACION_EVALUACION_MS = 15000
MUESTRAS_MINIMAS = 10
MARGEN_REPOSO = 10  # grados sobre el reposo medido del jugador para considerar que "empezó"
REPETICIONES_SEGUIDAS_RESINCRONIZAR = 3  # fotogramas coherentes tras un salto para aceptarlo


class ComandoInvalido(Exception):
    pass


class FiltroSaltos:
    """Regla 5: un salto de más de `maximo` grados entre fotogramas se trata como ruido.

    Si el valor nuevo se mantiene varios fotogramas (el jugador sí se movió, p. ej. tras
    perderse de vista), se acepta para no quedar bloqueado en el valor viejo.
    """

    def __init__(self, maximo: float) -> None:
        self.maximo = maximo
        self._ultimo: float | None = None
        self._candidatos: list[float] = []

    def aplicar(self, angulo: float | None) -> float | None:
        if angulo is None:
            return None
        if self._ultimo is None or abs(angulo - self._ultimo) <= self.maximo:
            self._ultimo, self._candidatos = angulo, []
            return angulo
        self._candidatos.append(angulo)
        coherentes = max(self._candidatos) - min(self._candidatos) <= self.maximo / 3
        if len(self._candidatos) >= REPETICIONES_SEGUIDAS_RESINCRONIZAR and coherentes:
            self._ultimo, self._candidatos = angulo, []
            return angulo
        if not coherentes:
            self._candidatos = [angulo]
        return None


@dataclass
class Actividad:
    """Lo que se está haciendo: una evaluación de rango o un ejercicio del juego."""
    tipo: str  # "evaluacion" o "juego"
    regla: ReglaEjercicio
    lado: str
    filtro: FiltroSaltos
    meta: float | None = None
    repeticiones_meta: int = 0
    contador: ContadorRepeticiones | None = None
    duracion_ms: int = DURACION_EVALUACION_MS
    vista_desde: int | None = None
    vista_ok: bool = False
    t_inicio: int | None = None
    angulos: list[float] = field(default_factory=list)  # válidos y sin compensación
    compensaciones: int = 0
    compensando: bool = False
    fuera_de_rango: bool = False
    fps: list[float] = field(default_factory=list)

    @property
    def clave(self) -> str:
        return f"{self.regla.articulacion}_{self.lado}"

    def mejor(self) -> float | None:
        """El valor más cercano a la meta: máximo en ejercicios "arriba", mínimo en "abajo"."""
        if not self.angulos:
            return None
        return max(self.angulos) if self.regla.direccion == "arriba" else min(self.angulos)

    def reposo(self) -> float | None:
        """La posición de partida del jugador: el extremo opuesto a la meta."""
        if not self.angulos:
            return None
        return min(self.angulos) if self.regla.direccion == "arriba" else max(self.angulos)


def _numero(datos: dict, nombre: str, minimo: float, maximo: float, por_defecto=None) -> float:
    valor = datos.get(nombre, por_defecto)
    if not isinstance(valor, (int, float)) or isinstance(valor, bool) or not minimo <= valor <= maximo:
        raise ComandoInvalido(f"{nombre} debe ser un número entre {minimo} y {maximo}")
    return valor


def _regla_y_lado(datos: dict) -> tuple[ReglaEjercicio, str]:
    reglas = cargar()
    regla = reglas.ejercicios.get(datos.get("ejercicio"))
    if regla is None:
        raise ComandoInvalido(f"ejercicio debe ser uno de {sorted(reglas.ejercicios)}")
    lado = datos.get("lado")
    if lado not in LADOS:
        raise ComandoInvalido("lado debe ser 'izq' o 'der'")
    return regla, lado


def crear_contador(regla: ReglaEjercicio, meta: float, tiempo_sostenido_ms: int,
                   reposo: float | None) -> ContadorRepeticiones:
    """Umbrales de la regla, adaptados a la posición de partida del jugador si se midió.

    Con AMC puede que el jugador no llegue a la posición de inicio de una persona sin
    contracturas (p. ej. rodilla recta = 0°): entonces su inicio es su propio reposo + margen.
    """
    tol = cargar().tolerancia_meta
    if regla.direccion == "arriba":
        inicio = regla.inicio if reposo is None else max(regla.inicio, reposo + MARGEN_REPOSO)
        if meta - tol <= inicio:
            raise ComandoInvalido(f"la meta ({meta}°) está muy cerca de tu posición inicial ({inicio:.0f}°)")
        return ContadorRepeticiones(umbral_meta=meta - tol, umbral_inicio=inicio, umbral_arranque=inicio,
                                    tiempo_sostenido_ms=tiempo_sostenido_ms, signo=1)
    arranque = regla.inicio if reposo is None else min(regla.inicio, reposo - MARGEN_REPOSO)
    retorno = min(regla.retorno, arranque)
    if meta + tol >= retorno:
        raise ComandoInvalido(f"la meta ({meta}°) está muy cerca de tu posición inicial ({retorno:.0f}°)")
    return ContadorRepeticiones(umbral_meta=-(meta + tol), umbral_inicio=-retorno, umbral_arranque=-arranque,
                                tiempo_sostenido_ms=tiempo_sostenido_ms, signo=-1)


class Controlador:
    def __init__(self) -> None:
        self.reglas = cargar()
        self.actividad: Actividad | None = None
        self.pausado = False

    @property
    def lado_activo(self) -> str | None:
        return self.actividad.lado if self.actividad else None

    # --- comandos -------------------------------------------------------------
    def comando(self, datos: dict) -> list[dict]:
        nombre = datos.get("nombre")
        try:
            if nombre in ("evaluar_rango", "iniciar_ejercicio"):
                eventos = [self._terminar("ejercicio_detenido")] if self.actividad else []
                regla, lado = _regla_y_lado(datos)
                filtro = FiltroSaltos(self.reglas.salto_maximo)
                if nombre == "evaluar_rango":
                    duracion = int(_numero(datos, "duracion_ms", 3000, 60000, DURACION_EVALUACION_MS))
                    self.actividad = Actividad("evaluacion", regla, lado, filtro, duracion_ms=duracion)
                else:
                    meta = _numero(datos, "meta", -180, 180, regla.meta_por_defecto)
                    if not regla.meta_valida(meta):
                        limite = regla.max_fisiologico if regla.direccion == "arriba" else regla.min_fisiologico
                        raise ComandoInvalido(
                            f"la meta {meta}° no es válida para «{regla.nombre}»: el límite de referencia es "
                            f"{limite}° y debe quedar lejos de la posición inicial")
                    reposo = datos.get("reposo")
                    if reposo is not None and not isinstance(reposo, (int, float)):
                        raise ComandoInvalido("reposo debe ser un número")
                    contador = crear_contador(
                        regla, meta, int(_numero(datos, "tiempo_sostenido_ms", 0, 30000, 0)), reposo)
                    self.actividad = Actividad(
                        "juego", regla, lado, filtro, meta=meta,
                        repeticiones_meta=int(_numero(datos, "repeticiones", 1, 50, 10)), contador=contador)
                self.pausado = False
                return eventos
            if nombre in ("pausar", "reanudar"):
                if not self.actividad:
                    raise ComandoInvalido("no hay ejercicio en curso")
                self.pausado = nombre == "pausar"
                return []
            if nombre == "detener":
                if not self.actividad:
                    raise ComandoInvalido("no hay ejercicio en curso")
                return [self._terminar("ejercicio_detenido")]
            raise ComandoInvalido(f"comando desconocido: {nombre}")
        except ComandoInvalido as e:
            return [{"nombre": "comando_rechazado", "comando": nombre, "motivo": str(e)}]

    # --- fotogramas -------------------------------------------------------------
    def procesar(self, t_ms: int, angulos: dict, vista: dict | None, fps: float) -> tuple[dict, list[dict]]:
        """Devuelve los campos extra del mensaje de fotograma y los eventos generados."""
        act = self.actividad
        if not act:
            return {}, []
        eventos: list[dict] = []

        # 1. Orientación: de lado y con la pierna medida hacia la cámara (regla 4).
        if not act.vista_ok:
            correcta = bool(vista and vista["lateral"] and vista["lado_camara"] == act.lado)
            if not correcta:
                act.vista_desde = None
            elif act.vista_desde is None:
                act.vista_desde = t_ms
            elif t_ms - act.vista_desde >= VISTA_ESTABLE_MS:
                act.vista_ok, act.t_inicio = True, t_ms
                eventos.append({"nombre": "vista_ok", "lado": act.lado})

        # 2. Ángulo medido y validaciones de la regla 5.
        regla, tol = act.regla, self.reglas.tolerancia_medicion
        angulo = angulos.get(act.clave)
        fuera = angulo is not None and not (regla.min_fisiologico - tol <= angulo <= regla.max_fisiologico + tol)
        if fuera and not act.fuera_de_rango and act.vista_ok:
            eventos.append({"nombre": "fuera_de_rango", "angulo": angulo,
                            "mensaje": "No te veo bien, revisa el encuadre"})
        act.fuera_de_rango = fuera
        angulo = act.filtro.aplicar(None if fuera else angulo)

        compensando = False
        if regla.compensacion and angulo is not None:
            otro = angulos.get(f"{regla.compensacion.angulo}_{act.lado}")
            compensando = otro is not None and otro > regla.compensacion.maximo
            if compensando and not act.compensando and act.vista_ok:
                act.compensaciones += 1
                eventos.append({"nombre": "compensacion", "mensaje": regla.compensacion.mensaje})
        act.compensando = compensando

        activo = act.vista_ok and not self.pausado
        if activo:
            act.fps.append(fps)
            if angulo is not None and not compensando:
                act.angulos.append(angulo)

        # 3. Evaluación de rango o conteo del juego.
        if act.tipo == "evaluacion":
            transcurrido = t_ms - act.t_inicio if act.t_inicio is not None else 0
            extra = {"evaluacion": {
                **self._comun(act, angulo, activo),
                "progreso": round(min(1.0, transcurrido / act.duracion_ms), 2),
            }}
            if act.vista_ok and transcurrido >= act.duracion_ms:
                eventos.append(self._terminar("evaluacion_lista"))
            return extra, eventos

        if activo:
            v = None if angulo is None else act.contador.signo * angulo
            resultado = act.contador.actualizar(t_ms, v, compensando)
            if resultado:
                rep = act.contador.repeticiones[-1]
                eventos.append({"nombre": resultado, "numero": rep.numero, "angulo_pico": rep.angulo_pico,
                                "sostenido_ms": rep.sostenido_ms, "motivo": rep.motivo})
        c = act.contador
        extra = {"rep": {
            **self._comun(act, angulo, activo),
            "estado": c.estado,
            "meta": act.meta,
            "umbral_meta": round(c.signo * c.umbral_meta, 1),
            "umbral_inicio": round(c.signo * c.umbral_inicio, 1),
            "validas": c.validas,
            "intentadas": len(c.repeticiones),
            "repeticiones_meta": act.repeticiones_meta,
            "sostenido_ms": c.sostenido_ms,
            "tiempo_sostenido_ms": c.tiempo_sostenido_ms,
        }}
        if c.validas >= act.repeticiones_meta:
            eventos.append(self._terminar("serie_completa"))
        return extra, eventos

    def _comun(self, act: Actividad, angulo: float | None, activo: bool) -> dict:
        if self.pausado:
            fase = "pausado"
        elif not act.vista_ok:
            fase = "verificando_vista"
        elif angulo is None:
            fase = "no_visible"
        else:
            fase = "midiendo"
        return {
            "ejercicio": act.regla.clave,
            "direccion": act.regla.direccion,
            "lado": act.lado,
            "fase": fase,
            "angulo": angulo,
            "mejor": act.mejor(),
            "max_fisiologico": act.regla.max_fisiologico,
            "compensacion": act.regla.compensacion.mensaje if act.compensando and act.regla.compensacion else None,
            "fuera_de_rango": act.fuera_de_rango,
        }

    def _terminar(self, nombre: str) -> dict:
        """Cierra la actividad y arma el resumen que el navegador guarda en la base de datos."""
        act = self.actividad
        self.actividad = None
        if nombre == "evaluacion_lista" and len(act.angulos) < MUESTRAS_MINIMAS:
            return {"nombre": "evaluacion_fallida", "ejercicio": act.regla.clave, "lado": act.lado,
                    "motivo": "sin_datos"}
        angulo_max = max(act.angulos) if act.angulos else None
        angulo_min = min(act.angulos) if act.angulos else None
        resumen = {
            "tipo": act.tipo,
            "ejercicio": act.regla.clave,
            "lado": act.lado,
            "meta": act.meta,
            "angulo_max": angulo_max,
            "angulo_min": angulo_min,
            "rango": None if angulo_max is None else round(angulo_max - angulo_min, 1),
            "mejor": act.mejor(),
            "reposo": act.reposo(),
            "compensaciones": act.compensaciones,
            "fps_promedio": round(sum(act.fps) / len(act.fps), 1) if act.fps else None,
            "completo": nombre in ("evaluacion_lista", "serie_completa"),
        }
        if act.contador:
            resumen["validas"] = act.contador.validas
            resumen["intentadas"] = len(act.contador.repeticiones)
            resumen["repeticiones"] = [vars(r) for r in act.contador.repeticiones]
        return {"nombre": nombre, "resumen": resumen}
