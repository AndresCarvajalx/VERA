"""Genera en Blender los personajes elegibles del juego: malla, materiales, esqueleto y exportación.

- toribara:   toro + capibara (cuernos, mechón, pezuñas).
- conejibara: conejo + capibara (orejas largas, dientes de conejo, cola de pompón, patas largas).

Todos comparten cuerpo de capibara, esqueleto, vendas y banda del guía; solo cambian la cabeza,
la cola, las manos, los pies y los colores. Por eso el juego los mueve con el mismo código.

Uso (sin abrir la ventana de Blender), desde la raíz del proyecto:
    "D:\\steam\\steamapps\\common\\Blender\\blender.exe" --background --factory-startup \
        --python modelado/generar_personajes.py -- [carpeta_de_vistas_previas]

Produce, por cada especie:
    modelado/<especie>.blend   para retocarlo a mano en Blender
    web/modelos/<especie>.glb  el que carga el juego
    web/modelos/<especie>.png  el retrato del selector de personaje

Convenciones (las usa web/toribara.js; no cambiarlas sin cambiar el juego):
- Blender: Z arriba, el personaje mira hacia −Y, su lado izquierdo está en +X. Metros.
- Huesos: raiz, columna, cabeza, hombro_izq/der, brazo_*, antebrazo_*, cadera_*, muslo_*,
  pierna_*, pie_*. Cada hueso apunta de su articulación a la siguiente.
- Objetos que el juego enciende o apaga: venda_completa_*, venda_parcial_*, banda_entrenador.
- Materiales que el juego tiñe: pelaje_pierna_izq / pelaje_pierna_der (la pierna que se fortalece).
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

RAIZ = Path(__file__).resolve().parents[1]
CARPETA_BLEND = RAIZ / "modelado"
CARPETA_WEB = RAIZ / "web" / "modelos"
LADOS = {"izq": 1, "der": -1}  # signo de x de cada lado del personaje

# --- articulaciones (metros) ---------------------------------------------------------
# Cada especie trae sus proporciones; el esqueleto (nombres y jerarquía) es siempre el mismo.
PROPORCIONES = {
    # Capibara: barrigón, piernas y brazos cortos (~1.3 m con la cabeza).
    "capibara": {"cadera_z": 0.47, "rodilla_z": 0.26, "tobillo_z": 0.06, "punta": (-0.13, 0.02),
                 "hombro_z": 0.83, "codo_z": 0.65, "muneca_z": 0.49, "cuello_z": 0.86,
                 "x_cadera": 0.11, "x_hombro": 0.25, "abre_codo": 0.04, "abre_muneca": 0.05, "cabeza_alto": 0.25},
    # Persona adulta de 1.70 m, en pose A (brazos levemente separados), como la guía.
    "humano": {"cadera_z": 0.92, "rodilla_z": 0.49, "tobillo_z": 0.08, "punta": (-0.15, 0.025),
               "hombro_z": 1.42, "codo_z": 1.14, "muneca_z": 0.89, "cuello_z": 1.47,
               "x_cadera": 0.09, "x_hombro": 0.19, "abre_codo": 0.05, "abre_muneca": 0.08, "cabeza_alto": 0.27},
}
P = dict(PROPORCIONES["capibara"])  # proporciones de la especie que se está construyendo (main)


def articulaciones(lado: str) -> dict[str, Vector]:
    s = LADOS[lado]
    return {
        "cadera": Vector((s * P["x_cadera"], 0, P["cadera_z"])),
        "rodilla": Vector((s * P["x_cadera"], -0.01, P["rodilla_z"])),
        "tobillo": Vector((s * P["x_cadera"], 0, P["tobillo_z"])),
        "punta": Vector((s * P["x_cadera"], *P["punta"])),
        "hombro": Vector((s * P["x_hombro"], 0, P["hombro_z"])),
        "codo": Vector((s * (P["x_hombro"] + P["abre_codo"]), 0.01, P["codo_z"])),
        "muneca": Vector((s * (P["x_hombro"] + P["abre_muneca"]), -0.01, P["muneca_z"])),
    }


# --- utilidades ----------------------------------------------------------------------
def limpiar_escena() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for coleccion in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures):
        for bloque in list(coleccion):
            coleccion.remove(bloque)


def material(nombre: str, color: tuple, rugosidad: float = 0.6, emision: tuple | None = None,
             intensidad: float = 0.0):
    mat = bpy.data.materials.new(nombre)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rugosidad
    if emision:
        bsdf.inputs["Emission Color"].default_value = (*emision, 1)
        bsdf.inputs["Emission Strength"].default_value = intensidad
    mat.diffuse_color = (*color, 1)  # color en la vista sólida y en las vistas previas
    return mat


def srgb(hex_color: str) -> tuple:
    """Color #rrggbb a lineal, que es lo que esperan los materiales de Blender."""
    c = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def esfera(nombre, centro, escala, mat, hueso, segmentos=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segmentos, ring_count=segmentos // 2, location=centro)
    obj = bpy.context.active_object
    obj.name = nombre
    obj.scale = escala
    return terminar(obj, mat, hueso)


def capsula(nombre, a: Vector, b: Vector, radio, mat, hueso, radio_b=None) -> list:
    """Cilindro con extremos redondeados entre a y b. Devuelve las tres piezas (cilindro y dos
    esferas): todas deben unirse al personaje, si no las esferas quedan quietas al animarlo."""
    radio_b = radio if radio_b is None else radio_b
    direccion = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=radio, radius2=radio_b, depth=direccion.length,
                                    location=(a + b) / 2)
    obj = bpy.context.active_object
    obj.name = nombre
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direccion)
    terminar(obj, mat, hueso)
    return [obj] + [esfera(f"{nombre}_extremo{i}", punto, (r, r, r), mat, hueso, segmentos=16)
                    for i, (punto, r) in enumerate(((a, radio), (b, radio_b)))]


def cono(nombre, base, punta, radio, mat, hueso):
    direccion = punta - base
    bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=radio, radius2=0.004, depth=direccion.length,
                                    location=(base + punta) / 2)
    obj = bpy.context.active_object
    obj.name = nombre
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direccion)
    return terminar(obj, mat, hueso)


def toro(nombre, centro, radio_mayor, radio_menor, mat, hueso, eje=(0, 0, 1), alto=1.0):
    """Anillo; `alto` > 1 lo estira a lo largo de su eje (una banda ancha, como una venda)."""
    bpy.ops.mesh.primitive_torus_add(major_radius=radio_mayor, minor_radius=radio_menor, location=centro,
                                     major_segments=32, minor_segments=10)
    obj = bpy.context.active_object
    obj.name = nombre
    obj.scale = (1, 1, alto)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector(eje))
    return terminar(obj, mat, hueso)


def terminar(obj, mat, hueso):
    """Aplica la transformación, suaviza, asigna material y lo pega rígidamente a un hueso."""
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.shade_smooth()
    obj.data.materials.append(mat)
    grupo = obj.vertex_groups.new(name=hueso)
    grupo.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    return obj


def unir(objetos, nombre):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objetos:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objetos[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = nombre
    obj.data.name = nombre
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


# --- esqueleto -----------------------------------------------------------------------
def crear_esqueleto():
    datos = bpy.data.armatures.new("esqueleto_toribara")
    esqueleto = bpy.data.objects.new("esqueleto_toribara", datos)
    bpy.context.collection.objects.link(esqueleto)
    bpy.context.view_layer.objects.active = esqueleto
    bpy.ops.object.mode_set(mode="EDIT")
    huesos = datos.edit_bones

    def hueso(nombre, cabeza, cola, padre=None):
        h = huesos.new(nombre)
        h.head, h.tail = Vector(cabeza), Vector(cola)
        h.roll = 0
        if padre:
            h.parent = huesos[padre]
        return h

    cadera_z, cuello_z = P["cadera_z"], P["cuello_z"]
    hueso("raiz", (0, 0, cadera_z), (0, 0, cadera_z + 0.1))
    hueso("columna", (0, 0, cadera_z), (0, 0, cuello_z), "raiz")
    hueso("cabeza", (0, 0, cuello_z), (0, 0, cuello_z + P["cabeza_alto"]), "columna")
    for lado in LADOS:
        a = articulaciones(lado)
        hueso(f"hombro_{lado}", (0, 0, P["hombro_z"]), a["hombro"], "columna")
        hueso(f"brazo_{lado}", a["hombro"], a["codo"], f"hombro_{lado}")
        hueso(f"antebrazo_{lado}", a["codo"], a["muneca"], f"brazo_{lado}")
        hueso(f"cadera_{lado}", (0, 0, cadera_z), a["cadera"], "raiz")
        hueso(f"muslo_{lado}", a["cadera"], a["rodilla"], f"cadera_{lado}")
        hueso(f"pierna_{lado}", a["rodilla"], a["tobillo"], f"muslo_{lado}")
        hueso(f"pie_{lado}", a["tobillo"], a["punta"], f"pierna_{lado}")
    bpy.ops.object.mode_set(mode="OBJECT")
    return esqueleto


def pegar_al_esqueleto(obj, esqueleto):
    modificador = obj.modifiers.new("esqueleto", "ARMATURE")
    modificador.object = esqueleto
    obj.parent = esqueleto


# --- personaje -----------------------------------------------------------------------
CZ = 1.05  # altura del centro de la cabeza


def detalles_toribara(m) -> list:
    """Toro: orejitas de capibara, cuernos curvos, mechón; cola corta; manos y pies con pezuñas."""
    partes = [esfera("cola", (0, 0.23, 0.55), (0.05, 0.05, 0.05), m["pelaje"], "columna", 12)]
    for s in (1, -1):
        partes.append(esfera(f"oreja_{s}", (s * 0.12, 0.08, CZ + 0.13), (0.045, 0.025, 0.05), m["pelaje"], "cabeza", 12))
        partes.append(esfera(f"oreja_int_{s}", (s * 0.12, 0.06, CZ + 0.13), (0.028, 0.012, 0.032), m["oscuro"], "cabeza", 10))
        # Cuerno en dos tramos: hacia afuera y luego hacia arriba.
        base, codo, punta = Vector((s * 0.09, 0.0, CZ + 0.12)), Vector((s * 0.18, -0.01, CZ + 0.16)), \
            Vector((s * 0.22, -0.02, CZ + 0.25))
        partes.extend(capsula(f"cuerno_base_{s}", base, codo, 0.028, m["cuerno"], "cabeza", 0.022))
        partes.append(cono(f"cuerno_punta_{s}", codo, punta, 0.022, m["cuerno"], "cabeza"))
    for i, (dx, dz) in enumerate(((0, 0.16), (0.03, 0.15), (-0.03, 0.15))):  # mechón
        partes.append(esfera(f"mechon_{i}", (dx, 0.0, CZ + dz), (0.03, 0.03, 0.035), m["oscuro"], "cabeza", 12))
    for lado in LADOS:
        a = articulaciones(lado)
        partes.append(esfera(f"mano_{lado}", a["muneca"] + Vector((0, 0, -0.035)), (0.05, 0.045, 0.05), m["oscuro"],
                             f"antebrazo_{lado}", 16))
        partes.append(esfera(f"pezuna_{lado}", a["punta"] + Vector((0, 0.02, 0.005)), (0.062, 0.07, 0.04), m["oscuro"],
                             f"pie_{lado}", 20))
    return partes


def detalles_conejibara(m) -> list:
    """Conejo: orejas largas con interior rosado, dientes, bigotes, cola de pompón y patas largas."""
    partes = [esfera("cola", (0, 0.25, 0.55), (0.09, 0.08, 0.09), m["claro"], "columna", 20)]
    # Mejillas esponjosas y dos dientes de conejo bajo la nariz.
    for s in (1, -1):
        partes.append(esfera(f"mejilla_{s}", (s * 0.08, -0.2, CZ - 0.06), (0.06, 0.05, 0.05), m["claro"], "cabeza", 16))
        partes.append(esfera(f"diente_{s}", (s * 0.017, -0.29, CZ - 0.105), (0.015, 0.008, 0.022), m["diente"], "cabeza", 10))
        for j, dz in enumerate((-0.015, 0.01)):  # puntos de los bigotes
            partes.append(esfera(f"bigote_{s}_{j}", (s * 0.075, -0.285, CZ - 0.03 + dz), (0.007, 0.005, 0.007),
                                 m["oscuro"], "cabeza", 8))
        # Oreja larga en dos tramos, abierta hacia los lados; interior rosado.
        base, medio, punta = Vector((s * 0.07, 0.04, CZ + 0.12)), Vector((s * 0.11, 0.06, CZ + 0.27)), \
            Vector((s * 0.15, 0.08, CZ + 0.42))
        partes.extend(capsula(f"oreja_baja_{s}", base, medio, 0.045, m["pelaje"], "cabeza", 0.05))
        partes.extend(capsula(f"oreja_alta_{s}", medio, punta, 0.05, m["pelaje"], "cabeza", 0.03))
        # Interior rosado: una franja que asoma por el frente de la oreja.
        interior = medio + Vector((s * 0.003, -0.042, 0.02))
        partes.append(esfera(f"oreja_int_{s}", interior, (0.028, 0.012, 0.12), m["rosa"], "cabeza", 14))
    for lado in LADOS:
        a = articulaciones(lado)
        partes.append(esfera(f"mano_{lado}", a["muneca"] + Vector((0, 0, -0.035)), (0.05, 0.045, 0.05), m["claro"],
                             f"antebrazo_{lado}", 16))
        # Pata trasera de conejo: larga y esponjosa, con la almohadilla rosada.
        partes.append(esfera(f"pata_{lado}", a["punta"] + Vector((0, -0.01, 0.0)), (0.06, 0.1, 0.04), m["claro"],
                             f"pie_{lado}", 20))
        partes.append(esfera(f"almohadilla_{lado}", a["punta"] + Vector((0, -0.08, -0.005)), (0.03, 0.025, 0.025),
                             m["rosa"], f"pie_{lado}", 12))
    return partes


def cuerpo_capibara(esqueleto, especie: str, datos: dict):
    """Cuerpo de juguete: piezas rígidas, cada una pegada a un hueso (toribara, conejibara)."""
    m = {
        "pelaje": material("pelaje", srgb(datos["pelaje"]), 0.85),
        "panza": material("panza", srgb(datos["panza"]), 0.9),
        "claro": material("pelaje_claro", srgb(datos["panza"]), 0.9),
        "oscuro": material("oscuro", srgb(datos["oscuro"]), 0.5),
        "nariz": material("nariz", srgb(datos["nariz"]), 0.4),
        "rosa": material("rosa", srgb("#ffb3c8"), 0.6),
        "diente": material("dientes", srgb("#fbfbf5"), 0.3),
        "cuerno": material("cuernos", srgb("#f3ead2"), 0.35),
        "ojo": material("ojos", srgb("#111014"), 0.15),
    }
    brillo_ojo = material("brillo_ojos", (1, 1, 1), 0.1, emision=(1, 1, 1), intensidad=2)
    neon = material("acento_neon", srgb("#ff2e97"), 0.3, emision=srgb("#ff2e97"), intensidad=1.5)
    piernas = {lado: material(f"pelaje_pierna_{lado}", srgb(datos["pelaje"]), 0.85) for lado in LADOS}
    pelaje = m["pelaje"]

    partes = []
    # Cuerpo de capibara: un barril con panza clara y una pañoleta neón.
    partes.append(esfera("cuerpo", (0, 0.01, 0.66), (0.27, 0.24, 0.30), pelaje, "columna", 32))
    partes.append(esfera("panza", (0, -0.12, 0.62), (0.20, 0.13, 0.22), m["panza"], "columna"))
    partes.append(toro("panoleta", (0, 0, 0.84), 0.15, 0.03, neon, "columna"))

    # Cabeza de capibara: cráneo alto, hocico largo y cuadrado con nariz ancha, ojos arriba.
    partes.append(esfera("cuello", (0, -0.01, P["cuello_z"] + 0.06), (0.12, 0.12, 0.08), pelaje, "cabeza", 20))
    partes.append(esfera("craneo", (0, 0.02, CZ), (0.17, 0.18, 0.15), pelaje, "cabeza", 32))
    partes.append(esfera("hocico", (0, -0.15, CZ - 0.03), (0.135, 0.17, 0.115), pelaje, "cabeza", 32))
    nariz = datos["nariz_tamano"]
    partes.append(esfera("nariz", (0, -0.31, CZ - 0.01 + (0.06 - nariz[2]) / 2), nariz, m["nariz"], "cabeza"))
    for s in (1, -1):
        fosa = (s * nariz[0] * 0.4, -0.31 - nariz[1] * 0.85, CZ - 0.01 + (0.06 - nariz[2]) / 2 + nariz[2] * 0.15)
        partes.append(esfera(f"fosa_{s}", fosa, (nariz[0] * 0.16, 0.01, nariz[2] * 0.2), m["ojo"], "cabeza", 10))
        partes.append(esfera(f"ojo_{s}", (s * 0.10, -0.08, CZ + 0.07), (0.03, 0.024, 0.03), m["ojo"], "cabeza", 16))
        partes.append(esfera(f"brillo_{s}", (s * 0.092, -0.102, CZ + 0.082), (0.009, 0.006, 0.009), brillo_ojo, "cabeza", 8))

    for lado in LADOS:
        a = articulaciones(lado)
        # Brazos cortos y regordetes, con una pulsera neón.
        partes.extend(capsula(f"brazo_{lado}", a["hombro"], a["codo"], 0.055, pelaje, f"brazo_{lado}", 0.048))
        partes.extend(capsula(f"antebrazo_{lado}", a["codo"], a["muneca"], 0.048, pelaje, f"antebrazo_{lado}", 0.042))
        partes.append(toro(f"pulsera_{lado}", a["muneca"] + Vector((0, 0, 0.03)), 0.045, 0.012, neon,
                           f"antebrazo_{lado}"))
        # Piernas con su propio material (la que se fortalece cambia de aspecto). El pie va unido al
        # tobillo; si no, al doblar la rodilla la punta del pie se ve suelta.
        partes.extend(capsula(f"muslo_{lado}", a["cadera"], a["rodilla"], 0.085, piernas[lado], f"muslo_{lado}", 0.065))
        partes.extend(capsula(f"pierna_{lado}", a["rodilla"], a["tobillo"], 0.065, piernas[lado], f"pierna_{lado}", 0.05))
        partes.extend(capsula(f"pie_{lado}", a["tobillo"], a["punta"], 0.05, piernas[lado], f"pie_{lado}", 0.045))
    partes.extend(datos["detalles"](m))

    cuerpo = unir(partes, especie)
    pegar_al_esqueleto(cuerpo, esqueleto)
    return cuerpo


# --- persona -------------------------------------------------------------------------
def segmentos_persona() -> dict[str, tuple[Vector, Vector]]:
    """Segmento (inicio, fin) que cubre cada hueso que deforma; sirve para vestir por zonas."""
    seg = {
        "columna": (Vector((0, 0, P["cadera_z"] - 0.02)), Vector((0, 0, P["cuello_z"]))),
        "cabeza": (Vector((0, 0, P["cuello_z"])), Vector((0, 0, P["cuello_z"] + P["cabeza_alto"]))),
    }
    for lado in LADOS:
        a = articulaciones(lado)
        seg[f"brazo_{lado}"] = (a["hombro"], a["codo"])
        seg[f"antebrazo_{lado}"] = (a["codo"], a["muneca"] + Vector((0, 0, -0.16)))  # incluye la mano
        seg[f"muslo_{lado}"] = (a["cadera"], a["rodilla"])
        seg[f"pierna_{lado}"] = (a["rodilla"], a["tobillo"])
        seg[f"pie_{lado}"] = (a["tobillo"] + Vector((0, 0.04, -0.04)), a["punta"])
    return seg


def distancia_segmento(p: Vector, a: Vector, b: Vector) -> tuple[float, float]:
    """Distancia de p al segmento ab y posición relativa (0 en a, 1 en b) del punto más cercano."""
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length, t


def cuerpo_persona(esqueleto, especie: str, datos: dict):
    """Persona deportiva de 1.70 m en una sola superficie continua y suave.

    Se arma con formas solapadas y luego se funde con un remallado por vóxeles (desaparecen las
    uniones), se suaviza, se reduce a un número de polígonos liviano para el navegador, se viste
    por zonas según el hueso más cercano y se pega al esqueleto con pesos suaves (automáticos):
    la piel se dobla en rodillas y codos en lugar de girar piezas rígidas.
    """
    gris = material("temporal", (0.5, 0.5, 0.5))
    cz = P["cuello_z"]
    cabeza = Vector((0, -0.005, cz + 0.155))
    partes = []
    # Cada forma recuerda su geometría y su zona de ropa: después del remallado, cada punto de
    # la superficie se viste según la forma sobre la que quedó (la más cercana).
    formas = []

    def elipsoide(nombre, centro, escala, hueso, zona, segmentos=32):
        partes.append(esfera(nombre, centro, escala, gris, hueso, segmentos))
        formas.append(("e", Vector(centro), Vector(escala), zona))

    def tubo(nombre, a, b, r1, r2, hueso, zona):
        partes.extend(capsula(nombre, a, b, r1, gris, hueso, r2))
        formas.append(("c", a, b, (r1, r2), zona))

    def cabello_o_piel(p):
        nuca = p.y > cabeza.y + 0.03 and p.z > cabeza.z - 0.05
        coronilla = p.z > cabeza.z + 0.025 and not (p.y < cabeza.y - 0.075 and p.z < cabeza.z + 0.07)
        return "cabello" if nuca or coronilla else "piel"

    # Tronco: pelvis, cintura, pecho y la línea de los hombros.
    elipsoide("pelvis", (0, 0.005, P["cadera_z"] + 0.03), (0.155, 0.1, 0.115), "raiz", "short", 40)
    elipsoide("cintura", (0, 0.0, 1.08), (0.13, 0.082, 0.16), "columna", "camiseta", 40)
    elipsoide("pecho", (0, -0.004, 1.255), (0.165, 0.094, 0.145), "columna", "camiseta", 40)
    elipsoide("hombros", (0, 0.005, 1.37), (0.185, 0.09, 0.068), "columna", "camiseta", 40)
    # Cabeza: cráneo, mandíbula, nariz, orejas y el volumen del cabello.
    elipsoide("craneo", cabeza, (0.09, 0.106, 0.116), "cabeza", cabello_o_piel, 48)
    elipsoide("mandibula", cabeza + Vector((0, -0.028, -0.06)), (0.07, 0.074, 0.058), "cabeza", "piel", 40)
    elipsoide("nariz", cabeza + Vector((0, -0.106, -0.012)), (0.014, 0.02, 0.026), "cabeza", "piel", 16)
    elipsoide("cabello", cabeza + Vector((0, 0.014, 0.034)), (0.098, 0.114, 0.098), "cabeza", cabello_o_piel, 48)
    tubo("cuello", Vector((0, 0.0, cz - 0.05)), Vector((0, 0.005, cz + 0.07)), 0.05, 0.05, "cabeza", "piel")
    for s in (1, -1):
        elipsoide(f"oreja_{s}", cabeza + Vector((s * 0.09, 0.008, -0.004)), (0.014, 0.024, 0.032), "cabeza", "piel", 16)
    for lado, s in LADOS.items():
        a = articulaciones(lado)
        pierna = f"pierna_{lado}"
        elipsoide(f"deltoides_{lado}", a["hombro"] + Vector((s * 0.004, 0, -0.012)), (0.052, 0.05, 0.056),
                  f"brazo_{lado}", "camiseta", 24)
        manga = lambda p, a=a: "camiseta" if distancia_segmento(p, a["hombro"], a["codo"])[1] < 0.4 else "piel"
        tubo(f"brazo_{lado}", a["hombro"], a["codo"], 0.047, 0.04, f"brazo_{lado}", manga)
        tubo(f"antebrazo_{lado}", a["codo"], a["muneca"], 0.04, 0.03, f"antebrazo_{lado}", "piel")
        elipsoide(f"mano_{lado}", a["muneca"] + Vector((s * 0.004, -0.004, -0.075)), (0.026, 0.04, 0.072),
                  f"antebrazo_{lado}", "piel", 24)
        elipsoide(f"gluteo_{lado}", (s * 0.075, 0.042, P["cadera_z"] - 0.04), (0.082, 0.072, 0.088), "raiz", "short", 24)
        # Muslo: el short cubre la parte de arriba; debajo, las mallas (la pierna que se fortalece).
        short = lambda p, a=a, pierna=pierna: "short" if distancia_segmento(p, a["cadera"], a["rodilla"])[1] < 0.2 else pierna
        tubo(f"muslo_{lado}", a["cadera"], a["rodilla"], 0.083, 0.057, f"muslo_{lado}", short)
        elipsoide(f"cuadriceps_{lado}", a["cadera"].lerp(a["rodilla"], 0.4) + Vector((0, -0.01, 0)),
                  (0.072, 0.07, 0.13), f"muslo_{lado}", short, 24)
        tubo(f"pierna_{lado}", a["rodilla"], a["tobillo"], 0.054, 0.036, f"pierna_{lado}", pierna)
        elipsoide(f"gemelo_{lado}", a["rodilla"].lerp(a["tobillo"], 0.3) + Vector((0, 0.016, 0)),
                  (0.053, 0.056, 0.1), f"pierna_{lado}", pierna, 24)
        # Zapatilla: cuerpo alargado y talón redondeado.
        centro = (a["tobillo"] + a["punta"]) / 2 + Vector((0, 0.01, -0.018))
        elipsoide(f"zapatilla_{lado}", centro, (0.056, 0.142, 0.048), f"pie_{lado}", "zapatilla", 32)
        elipsoide(f"talon_{lado}", a["tobillo"] + Vector((0, 0.035, -0.035)), (0.05, 0.054, 0.05),
                  f"pie_{lado}", "zapatilla", 24)

    cuerpo = unir(partes, especie)
    # 1. Fundir todo en una sola superficie cerrada (sin uniones entre piezas).
    remallar = cuerpo.modifiers.new("fundir", "REMESH")
    remallar.mode, remallar.voxel_size, remallar.use_smooth_shade = "VOXEL", 0.0055, True
    bpy.ops.object.modifier_apply(modifier=remallar.name)
    # 2. Suavizar los pliegues donde se juntaban las formas.
    suavizar = cuerpo.modifiers.new("suavizar", "SMOOTH")
    suavizar.factor, suavizar.iterations = 0.6, 12
    bpy.ops.object.modifier_apply(modifier=suavizar.name)
    # 3. Liviano para el navegador (~30 000 triángulos).
    reducir = cuerpo.modifiers.new("reducir", "DECIMATE")
    reducir.ratio = min(1.0, 15000 / max(1, len(cuerpo.data.polygons)))
    bpy.ops.object.modifier_apply(modifier=reducir.name)
    cuerpo.data.validate()  # quita caras degeneradas que deja la reducción
    bpy.ops.object.shade_smooth()
    cuerpo.vertex_groups.clear()

    # 4. Vestir por zonas: cada cara toma la zona de la forma sobre cuya superficie quedó.
    colores = datos["colores"]
    mats = {
        "piel": material("piel", srgb(colores["piel"]), 0.55),
        "cabello": material("cabello", srgb(colores["cabello"]), 0.6),
        "camiseta": material("camiseta", srgb(colores["camiseta"]), 0.5),
        "short": material("short", srgb(colores["short"]), 0.7),
        "zapatilla": material("zapatilla", srgb(colores["zapatilla"]), 0.4),
        "pierna_izq": material("pelaje_pierna_izq", srgb(colores["mallas"]), 0.7),  # la pierna que se fortalece
        "pierna_der": material("pelaje_pierna_der", srgb(colores["mallas"]), 0.7),
    }
    cuerpo.data.materials.clear()
    indice = {}
    for clave, mat in mats.items():
        cuerpo.data.materials.append(mat)
        indice[clave] = len(cuerpo.data.materials) - 1
    def distancia_forma(p, forma):
        """Distancia aproximada (m) de p a la superficie de la forma: ~0 si p quedó sobre ella."""
        if forma[0] == "e":
            _, c, escala, _ = forma
            q = Vector(((p.x - c.x) / escala.x, (p.y - c.y) / escala.y, (p.z - c.z) / escala.z))
            return (q.length - 1) * min(escala)
        _, a, b, (r1, r2), _ = forma
        d, t = distancia_segmento(p, a, b)
        return d - (r1 + (r2 - r1) * t)

    for cara in cuerpo.data.polygons:
        c = cara.center
        zona = min(formas, key=lambda f: abs(distancia_forma(c, f)))[-1]
        cara.material_index = indice[zona(c) if callable(zona) else zona]
    segmentos = segmentos_persona()

    # Rasgos de la cara (piezas pequeñas sobre la superficie ya fundida).
    rasgos = []
    ojo = material("ojos", srgb("#1c1410"), 0.2)
    brillo = material("brillo_ojos", (1, 1, 1), 0.1, emision=(1, 1, 1), intensidad=2)
    boca = material("boca", srgb("#b4615a"), 0.5)
    for s in (1, -1):
        rasgos.append(esfera(f"ojo_{s}", cabeza + Vector((s * 0.034, -0.094, 0.012)), (0.012, 0.008, 0.014), ojo, "cabeza", 16))
        rasgos.append(esfera(f"brillo_{s}", cabeza + Vector((s * 0.031, -0.101, 0.017)), (0.0035, 0.002, 0.0035),
                             brillo, "cabeza", 8))
        rasgos.append(esfera(f"ceja_{s}", cabeza + Vector((s * 0.035, -0.097, 0.04)), (0.022, 0.006, 0.005),
                             mats["cabello"], "cabeza", 12))
    rasgos.append(esfera("boca", cabeza + Vector((0, -0.094, -0.052)), (0.02, 0.005, 0.0045), boca, "cabeza", 12))
    for r in rasgos:
        r.vertex_groups.clear()
    cuerpo = unir([cuerpo] + rasgos, especie)
    cuerpo.data.validate()

    # 5. Pesos suaves: Blender calcula cuánto influye cada hueso en cada vértice.
    bpy.ops.object.select_all(action="DESELECT")
    cuerpo.select_set(True)
    esqueleto.select_set(True)
    bpy.context.view_layer.objects.active = esqueleto
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    sin_peso = [v.index for v in cuerpo.data.vertices if not any(g.weight > 0 for g in v.groups)]
    if sin_peso:  # respaldo: el hueso más cercano, para que ningún vértice quede quieto
        for i in sin_peso:
            p = cuerpo.data.vertices[i].co
            hueso = min(segmentos, key=lambda n: distancia_segmento(p, *segmentos[n])[0])
            grupo = cuerpo.vertex_groups.get(hueso) or cuerpo.vertex_groups.new(name=hueso)
            grupo.add([i], 1.0, "REPLACE")
    # El cálculo automático deja algunos pesos apenas sobre 1 (p. ej. 1.0098): se normalizan para
    # que los de cada vértice sumen exactamente 1 (si no, la malla no es válida para glTF).
    for v in cuerpo.data.vertices:
        total = sum(g.weight for g in v.groups)
        if total > 0:
            for g in v.groups:
                g.weight /= total
    print(f"persona: {len(cuerpo.data.polygons)} caras, {len(sin_peso)} vértices sin peso automático")
    return cuerpo


ESPECIES = {
    # nariz: tamaño de la nariz en la punta del hocico (ancha de capibara o pequeña de conejo).
    # banda: (centro y, centro z, radio) de la banda del guía.
    "persona": {"proporciones": "humano", "cuerpo": cuerpo_persona, "banda": (0.0, 1.665, 0.104),
                "colores": {"piel": "#d9a07a", "cabello": "#2a1d17", "camiseta": "#ff2e97", "short": "#14172a",
                            "mallas": "#2b3150", "zapatilla": "#f2f3f7"}},
    "toribara": {"proporciones": "capibara", "cuerpo": cuerpo_capibara, "banda": (0.02, CZ + 0.08, 0.165),
                 "pelaje": "#9a5b34", "panza": "#e8c39a", "oscuro": "#2b1a14", "nariz": "#2b1a14",
                 "nariz_tamano": (0.10, 0.035, 0.06), "detalles": detalles_toribara},
    "conejibara": {"proporciones": "capibara", "cuerpo": cuerpo_capibara, "banda": (0.02, CZ + 0.08, 0.165),
                   "pelaje": "#c99a6b", "panza": "#fbefe0", "oscuro": "#4a3027", "nariz": "#e86a92",
                   "nariz_tamano": (0.045, 0.028, 0.032), "detalles": detalles_conejibara},
}


def crear_personaje(esqueleto, especie: str):
    datos = ESPECIES[especie]
    cuerpo = datos["cuerpo"](esqueleto, especie, datos)
    # Ninguna pieza puede quedar suelta: todo lo que no es esqueleto, vendas o banda es del cuerpo.
    sueltas = [o.name for o in bpy.data.objects if o.type == "MESH" and o is not cuerpo]
    assert not sueltas, f"Piezas sin unir al personaje: {sueltas}"
    venda = material("venda", srgb("#f5f2ea"), 0.95)
    banda = material("banda_entrenador", srgb("#00e5ff"), 0.3, emision=srgb("#00e5ff"), intensidad=1.5)

    # Vendas: bandas anchas que se superponen alrededor de la pierna, levemente inclinadas
    # (como una venda enrollada), en dos versiones: completa y a medio quitar.
    for lado, s in LADOS.items():
        a = articulaciones(lado)
        anillos_completa, anillos_parcial = [], []
        # Una vuelta cada ~5 cm: así la venda cubre igual una pierna corta (capibara) que una larga.
        n_muslo = max(4, round((a["cadera"] - a["rodilla"]).length / 0.05))
        n_pierna = max(4, round((a["rodilla"] - a["tobillo"]).length / 0.05))
        for i in range(n_muslo):
            t = (i + 0.5) / n_muslo
            centro = a["cadera"].lerp(a["rodilla"], t)
            eje = (0.12 * s * (1 if i % 2 else -1), 0, 1)
            anillos_completa.append(toro(f"venda_m{i}_{lado}", centro, 0.078 - 0.018 * t, 0.014, venda,
                                         f"muslo_{lado}", eje=eje, alto=2.6))
        for i in range(n_pierna):
            t = (i + 0.5) / n_pierna
            centro = a["rodilla"].lerp(a["tobillo"], t)
            radio = 0.06 - 0.013 * t
            eje = (0.12 * s * (1 if i % 2 else -1), 0, 1)
            anillos_completa.append(toro(f"venda_p{i}_{lado}", centro, radio, 0.013, venda, f"pierna_{lado}",
                                         eje=eje, alto=2.6))
            if i >= n_pierna // 2:
                anillos_parcial.append(toro(f"venda_pp{i}_{lado}", centro, radio, 0.013, venda, f"pierna_{lado}",
                                            eje=eje, alto=2.6))
        for nombre, anillos in ((f"venda_completa_{lado}", anillos_completa), (f"venda_parcial_{lado}", anillos_parcial)):
            obj = unir(anillos, nombre)
            pegar_al_esqueleto(obj, esqueleto)

    # Banda de entrenador (solo la lleva el guía).
    banda_y, banda_z, banda_r = datos["banda"]
    obj = toro("banda_entrenador", (0, banda_y, banda_z), banda_r, 0.02 * banda_r / 0.165, banda, "cabeza",
               eje=(0, 0.25, 1), alto=1.6)
    obj.name = "banda_entrenador"
    pegar_al_esqueleto(obj, esqueleto)


# --- imágenes ------------------------------------------------------------------------
def preparar_render(tamano: int, transparente: bool):
    escena = bpy.context.scene
    escena.render.engine = "BLENDER_WORKBENCH"
    escena.display.shading.light = "STUDIO"
    escena.display.shading.color_type = "MATERIAL"
    escena.display.shading.show_shadows = True
    escena.render.resolution_x = escena.render.resolution_y = tamano
    escena.render.film_transparent = transparente
    escena.render.image_settings.color_mode = "RGBA" if transparente else "RGB"
    datos = bpy.data.cameras.new("camara_previa")
    camara = bpy.data.objects.new("camara_previa", datos)
    escena.collection.objects.link(camara)
    escena.camera = camara
    return escena, camara


def altura_personaje() -> float:
    """Altura (m) del personaje en la escena, para encuadrar igual a especies de distinto tamaño."""
    return max((o.matrix_world @ Vector(v)).z for o in bpy.data.objects if o.type == "MESH" for v in o.bound_box)


def apuntar(camara, objetivo: Vector, angulo: float, distancia: float) -> None:
    rad = math.radians(angulo)
    camara.location = objetivo + Vector((math.sin(rad) * distancia, -math.cos(rad) * distancia, 0.25))
    camara.rotation_mode = "QUATERNION"
    camara.rotation_quaternion = (objetivo - camara.location).to_track_quat("-Z", "Y")


def retrato(especie: str) -> None:
    """Imagen del selector de personaje: tres cuartos, fondo transparente, sin vendas ni banda."""
    escena, camara = preparar_render(360, transparente=True)
    opcionales = [o for o in bpy.data.objects if o.name.startswith(("venda_", "banda_"))]
    for o in opcionales:
        o.hide_render = True
    # Encuadre justo (pies a cabeza): el retrato se ve en una tarjeta pequeña.
    altura = altura_personaje()
    apuntar(camara, Vector((0, 0, altura * 0.53)), 30, altura * 1.75)
    escena.render.filepath = str(CARPETA_WEB / f"{especie}.png")
    bpy.ops.render.render(write_still=True)
    for o in opcionales:
        o.hide_render = False
    bpy.data.objects.remove(camara)


def vistas_previas(carpeta: Path, especie: str) -> None:
    carpeta.mkdir(parents=True, exist_ok=True)
    escena, camara = preparar_render(700, transparente=False)
    altura = altura_personaje()
    objetivo = Vector((0, 0, altura * 0.48))
    variantes = {  # qué objetos opcionales se ven en cada vista previa
        "jugador": set(),
        "guia": {"banda_entrenador"},
        "vendada": {"venda_completa_der"},
        "venda_parcial": {"venda_parcial_der"},
    }
    opcionales = [o for o in bpy.data.objects if o.name.startswith(("venda_", "banda_"))]
    for variante, visibles in variantes.items():
        for o in opcionales:
            o.hide_render = o.name not in visibles
        for nombre, angulo in (("frente", 0), ("tres_cuartos", 35), ("lado", 90)):
            if variante != "jugador" and nombre != "tres_cuartos":
                continue
            apuntar(camara, objetivo, angulo, altura * 2.1)
            escena.render.filepath = str(carpeta / f"{especie}_{variante}_{nombre}.png")
            bpy.ops.render.render(write_still=True)
    for o in opcionales:
        o.hide_render = False
    bpy.data.objects.remove(camara)


def main() -> None:
    argumentos = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    CARPETA_WEB.mkdir(parents=True, exist_ok=True)
    for especie, datos in ESPECIES.items():
        P.clear()
        P.update(PROPORCIONES[datos["proporciones"]])
        limpiar_escena()
        esqueleto = crear_esqueleto()
        crear_personaje(esqueleto, especie)
        bpy.ops.wm.save_as_mainfile(filepath=str(CARPETA_BLEND / f"{especie}.blend"))
        glb = CARPETA_WEB / f"{especie}.glb"
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB")
        retrato(especie)
        print(f"OK {glb}")
        if argumentos:
            vistas_previas(Path(argumentos[0]), especie)


main()
