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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from api import bd as base_datos
from api.rutas import rutas as rutas_api

from .captura import BucleCaptura
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
    bucle = BucleCaptura(
        EstimadorMediaPipe(MODELO),
        difusor.publicar_desde_hilo,
        indice_camara=int(os.environ.get("CAMARA", "0")),
    )
    bucle.iniciar()
    yield
    bucle.detener()


app = FastAPI(title="Servicio de visión AMC", lifespan=ciclo_de_vida)
app.include_router(rutas_api, prefix="/api")


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
