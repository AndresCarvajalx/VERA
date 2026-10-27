"""Analiza las calibraciones reales guardadas en data/trazas/ y mide su precisión.

Por cada traza: rango calibrado, picos de los intentos, dispersión, fotogramas sin medida y
saltos sospechosos (ángulos negativos grandes en flexiones: típicos de un signo invertido).
Por ejercicio y pierna: repetibilidad entre calibraciones (desviación estándar y rango del
valor calibrado). También vuelve a calcular cada calibración con los parámetros actuales de
config/reglas_rom.json, para ver cómo cambiaría el resultado si se ajustan.

Uso (desde la carpeta vision):  ..\\.venv\\Scripts\\python herramientas\\analizar_calibraciones.py [carpeta]
"""
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import trazas  # noqa: E402
from app.calibracion import Calibracion  # noqa: E402
from app.reglas import cargar  # noqa: E402

SOSPECHOSO = -20  # grados: en una flexión, por debajo de esto casi seguro es un signo invertido


def analizar_traza(ruta_csv: Path) -> dict:
    datos = json.loads(ruta_csv.with_suffix(".json").read_text(encoding="utf-8"))
    regla = cargar().ejercicios[datos["ejercicio"]]
    traza = trazas.leer(ruta_csv)
    medidos = [a for _, a in traza if a is not None]
    signo = 1 if regla.direccion == "arriba" else -1
    recalculo = Calibracion(cargar().calibracion, signo)
    resultado = None
    for t, angulo in traza:
        resultado = recalculo.actualizar(t, angulo) or resultado
        if resultado:
            break
    return {
        "archivo": ruta_csv.name,
        "clave": (datos["ejercicio"], datos["lado"]),
        "mejor": datos["mejor"],
        "reposo": datos["reposo"],
        "intentos": datos["intentos"],
        "dispersion": datos["dispersion"],
        "consistente": datos["consistente"],
        "fotogramas": len(traza),
        "sin_medida": round(100 * (len(traza) - len(medidos)) / max(1, len(traza)), 1),
        "sospechosos": sum(1 for a in medidos if signo == 1 and a < SOSPECHOSO),
        "recalculado": resultado[1]["mejor"] if resultado and resultado[0] == "lista" else None,
    }


def main(carpeta: Path) -> None:
    archivos = sorted(carpeta.glob("*.csv"))
    if not archivos:
        print(f"No hay trazas en {carpeta}. Haz al menos una calibración.")
        return
    filas = [analizar_traza(a) for a in archivos]
    print(f"{'archivo':45} {'reposo':>7} {'mejor':>7} {'disp.':>6} {'sin med.':>8} {'sosp.':>6}  intentos")
    for f in filas:
        print(f"{f['archivo']:45} {f['reposo']:7.1f} {f['mejor']:7.1f} {f['dispersion']:6.1f} "
              f"{f['sin_medida']:7.1f}% {f['sospechosos']:6d}  {f['intentos']}"
              + ("" if f["consistente"] else "  (poco consistente)"))
    print("\nRepetibilidad por ejercicio y pierna (entre calibraciones):")
    grupos: dict[tuple, list[float]] = {}
    for f in filas:
        grupos.setdefault(f["clave"], []).append(f["mejor"])
    for (ejercicio, lado), valores in grupos.items():
        if len(valores) < 2:
            print(f"  {ejercicio} {lado}: una sola calibración ({valores[0]}°); hacen falta al menos 2")
            continue
        print(f"  {ejercicio} {lado}: n={len(valores)}, media {statistics.mean(valores):.1f}°, "
              f"desviación {statistics.stdev(valores):.1f}°, máx−mín {max(valores) - min(valores):.1f}°")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else trazas.DIRECTORIO)
