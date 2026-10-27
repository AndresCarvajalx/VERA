"""Trazas de calibración: el ángulo de cada fotograma de una calibración real, en CSV.

Sirven para evaluar la precisión y la repetibilidad con datos reales (OE4) y para ajustar los
parámetros de config/reglas_rom.json. Solo contienen tiempos y ángulos: ni imágenes ni datos del
jugador (el archivo no lleva su código). Se guardan en data/trazas/, fuera del repositorio.
"""
import csv
import json
from datetime import datetime
from pathlib import Path

DIRECTORIO = Path(__file__).resolve().parents[2] / "data" / "trazas"


def guardar(ejercicio: str, lado: str, traza: list[tuple[int, float | None]], resumen: dict,
            directorio: Path = DIRECTORIO) -> Path:
    directorio.mkdir(parents=True, exist_ok=True)
    nombre = f"{datetime.now():%Y%m%d-%H%M%S}_{ejercicio}_{lado}"
    ruta = directorio / f"{nombre}.csv"
    t0 = traza[0][0] if traza else 0
    with ruta.open("w", newline="", encoding="utf-8") as archivo:
        escritor = csv.writer(archivo)
        escritor.writerow(["t_ms", "angulo"])
        for t, angulo in traza:
            escritor.writerow([t - t0, "" if angulo is None else angulo])
    campos = ("mejor", "reposo", "rango", "intentos", "dispersion", "consistente")
    (directorio / f"{nombre}.json").write_text(
        json.dumps({"ejercicio": ejercicio, "lado": lado, **{k: resumen.get(k) for k in campos}},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    return ruta


def leer(ruta: Path) -> list[tuple[int, float | None]]:
    with ruta.open(encoding="utf-8") as archivo:
        return [(int(fila["t_ms"]), float(fila["angulo"]) if fila["angulo"] else None)
                for fila in csv.DictReader(archivo)]
