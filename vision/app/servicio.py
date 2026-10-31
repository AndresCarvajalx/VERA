"""Servicio de visión local: expone los mensajes del bucle de captura por WebSocket.

En el prototipo también monta la API de datos (paquete `api`) bajo /api.

Ejecutar desde la carpeta vision:
    ..\\.venv\\Scripts\\python -m uvicorn app.servicio:app --port 8765
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from api import bd as base_datos
from api.rutas import rutas as rutas_api

from . import ajustes
from .captura import BucleCaptura, es_url_de_camara, listar_camaras
from .estimador import EstimadorMediaPipe

RAIZ = Path(__file__).resolve().parents[2]
MODELO = RAIZ / "vision" / "models" / "pose_landmarker_full.task"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("servicio")


class Difusor:
    """Reparte cada mensaje a todos los clientes; si uno va lento se descartan sus mensajes viejos."""

    def __init__(self) -> None:
        self._colas: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def enlazar(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def publicar_desde_hilo(self, mensaje: dict) -> None:
        if self._loop:
            self._loop.call_soon_threadsafe(self._publicar, mensaje)

    def _publicar(self, mensaje: dict) -> None:
        for cola in self._colas:
            if cola.full():
                cola.get_nowait()
            cola.put_nowait(mensaje)

    def suscribir(self) -> asyncio.Queue:
        cola: asyncio.Queue = asyncio.Queue(maxsize=4)
        self._colas.add(cola)
        return cola

    def desuscribir(self, cola: asyncio.Queue) -> None:
        self._colas.discard(cola)


difusor = Difusor()
bucle: BucleCaptura | None = None


@asynccontextmanager
async def ciclo_de_vida(app: FastAPI):
    global bucle
    base_datos.iniciar()
    difusor.enlazar(asyncio.get_running_loop())
    # La variable de entorno CAMARA manda; si no, la última elegida en Ajustes; si no, la 0.
    fuente = int(os.environ["CAMARA"]) if "CAMARA" in os.environ else ajustes.leer().get("camara", 0)
    bucle = BucleCaptura(EstimadorMediaPipe(MODELO), difusor.publicar_desde_hilo, indice_camara=fuente)
    bucle.iniciar()
    yield
    bucle.detener()


app = FastAPI(title="Servicio de visión AMC", lifespan=ciclo_de_vida)
app.include_router(rutas_api, prefix="/api")


# --- cámara (Ajustes) -------------------------------------------------------------
class CambioCamara(BaseModel):
    fuente: int | str  # índice de una cámara del equipo, o URL de la cámara de un celular


@app.get("/api/camara")
def ver_camara() -> dict:
    """La cámara en uso y las del equipo que responden (abrir cada una tarda ~1 s)."""
    actual = bucle.fuente
    return {"actual": actual, "dispositivos": listar_camaras(excluir=actual if isinstance(actual, int) else None)}


@app.put("/api/camara")
def cambiar_camara(datos: CambioCamara) -> dict:
    fuente = datos.fuente
    if isinstance(fuente, str):
        fuente = fuente.strip()
        if fuente.isdigit():
            fuente = int(fuente)
        elif not es_url_de_camara(fuente):
            raise HTTPException(422, "La cámara debe ser un número (0, 1, ...) o una URL http://, https:// o rtsp://")
    if isinstance(fuente, int) and not 0 <= fuente <= 9:
        raise HTTPException(422, "El número de cámara va de 0 a 9")
    try:
        abrio = bucle.cambiar_camara(fuente).result(timeout=20)
    except TimeoutError:
        raise HTTPException(504, "La cámara tardó demasiado en responder")
    if not abrio:
        raise HTTPException(409, f"No se pudo abrir la cámara {fuente}; se sigue usando la anterior")
    ajustes.guardar({"camara": fuente})
    return {"actual": fuente}


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    cola = difusor.suscribir()
    log.info("Cliente conectado")

    async def recibir() -> None:
        # {"tipo": "comando", "nombre": "calibrar" | "iniciar_ejercicio" | "pausar" | "reanudar" | "detener", ...}
        while True:
            try:
                datos = await websocket.receive_json()
            except ValueError:
                log.warning("Mensaje que no es JSON, ignorado")
                continue
            if isinstance(datos, dict) and datos.get("tipo") == "comando" and bucle:
                bucle.enviar_comando(datos)

    receptor = asyncio.create_task(recibir())
    try:
        while True:
            await websocket.send_json(await cola.get())
    except (WebSocketDisconnect, RuntimeError):  # RuntimeError: envío a un socket ya cerrado
        pass
    finally:
        receptor.cancel()
        difusor.desuscribir(cola)
        log.info("Cliente desconectado")


class ArchivosSinCache(StaticFiles):
    """En desarrollo el navegador guardaba versiones viejas de prueba.js; así siempre revalida."""

    def file_response(self, *args, **kwargs):
        respuesta = super().file_response(*args, **kwargs)
        respuesta.headers["Cache-Control"] = "no-cache"
        return respuesta


app.mount("/", ArchivosSinCache(directory=RAIZ / "web", html=True), name="web")
