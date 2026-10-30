"""Genera el "toribara" (toro + capibara) en Blender: malla, materiales, esqueleto y exportación.

Uso (sin abrir la ventana de Blender), desde la raíz del proyecto:
    "D:\\steam\\steamapps\\common\\Blender\\blender.exe" --background --factory-startup \
        --python modelado/generar_toribara.py -- [carpeta_de_vistas_previas]

Produce:
    modelado/toribara.blend   para retocarlo a mano en Blender
    web/modelos/toribara.glb  el que carga el juego

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
SALIDA_BLEND = RAIZ / "modelado" / "toribara.blend"
SALIDA_GLB = RAIZ / "web" / "modelos" / "toribara.glb"
LADOS = {"izq": 1, "der": -1}  # signo de x de cada lado del personaje

# --- articulaciones (metros) ---------------------------------------------------------
CADERA_Z, RODILLA_Z, TOBILLO_Z = 0.47, 0.26, 0.06
HOMBRO_Z, CODO_Z, MUNECA_Z = 0.83, 0.65, 0.49
CUELLO_Z = 0.86
X_CADERA, X_HOMBRO = 0.11, 0.25


def articulaciones(lado: str) -> dict[str, Vector]:
    s = LADOS[lado]
    return {
        "cadera": Vector((s * X_CADERA, 0, CADERA_Z)),
        "rodilla": Vector((s * X_CADERA, -0.01, RODILLA_Z)),
        "tobillo": Vector((s * X_CADERA, 0, TOBILLO_Z)),
        "punta": Vector((s * X_CADERA, -0.13, 0.02)),
        "hombro": Vector((s * X_HOMBRO, 0, HOMBRO_Z)),
        "codo": Vector((s * (X_HOMBRO + 0.04), 0.01, CODO_Z)),
        "muneca": Vector((s * (X_HOMBRO + 0.05), -0.01, MUNECA_Z)),
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

    hueso("raiz", (0, 0, CADERA_Z), (0, 0, CADERA_Z + 0.1))
    hueso("columna", (0, 0, CADERA_Z), (0, 0, CUELLO_Z), "raiz")
    hueso("cabeza", (0, 0, CUELLO_Z), (0, 0, CUELLO_Z + 0.25), "columna")
    for lado in LADOS:
        a = articulaciones(lado)
        hueso(f"hombro_{lado}", (0, 0, HOMBRO_Z), a["hombro"], "columna")
        hueso(f"brazo_{lado}", a["hombro"], a["codo"], f"hombro_{lado}")
        hueso(f"antebrazo_{lado}", a["codo"], a["muneca"], f"brazo_{lado}")
        hueso(f"cadera_{lado}", (0, 0, CADERA_Z), a["cadera"], "raiz")
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
def crear_personaje(esqueleto):
    pelaje = material("pelaje", srgb("#9a5b34"), 0.85)
    panza = material("panza", srgb("#e8c39a"), 0.9)
    oscuro = material("pezunas_nariz", srgb("#2b1a14"), 0.5)
    cuerno = material("cuernos", srgb("#f3ead2"), 0.35)
    ojo = material("ojos", srgb("#111014"), 0.15)
    brillo_ojo = material("brillo_ojos", (1, 1, 1), 0.1, emision=(1, 1, 1), intensidad=2)
    neon = material("acento_neon", srgb("#ff2e97"), 0.3, emision=srgb("#ff2e97"), intensidad=1.5)
    piernas = {lado: material(f"pelaje_pierna_{lado}", srgb("#9a5b34"), 0.85) for lado in LADOS}
    venda = material("venda", srgb("#f5f2ea"), 0.95)
    banda = material("banda_entrenador", srgb("#00e5ff"), 0.3, emision=srgb("#00e5ff"), intensidad=1.5)

    partes = []
    # Cuerpo de capibara: un barril con panza clara.
    partes.append(esfera("cuerpo", (0, 0.01, 0.66), (0.27, 0.24, 0.30), pelaje, "columna", 32))
    partes.append(esfera("panza", (0, -0.12, 0.62), (0.20, 0.13, 0.22), panza, "columna"))
    partes.append(esfera("cola", (0, 0.23, 0.55), (0.05, 0.05, 0.05), pelaje, "columna", 12))
    partes.append(toro("panoleta", (0, 0, 0.84), 0.15, 0.03, neon, "columna"))

    # Cabeza de capibara: cráneo alto, hocico largo y cuadrado con nariz ancha, ojos arriba,
    # orejitas redondas; más los cuernos de toro.
    cz = 1.05
    partes.append(esfera("cuello", (0, -0.01, CUELLO_Z + 0.06), (0.12, 0.12, 0.08), pelaje, "cabeza", 20))
    partes.append(esfera("craneo", (0, 0.02, cz), (0.17, 0.18, 0.15), pelaje, "cabeza", 32))
    partes.append(esfera("hocico", (0, -0.15, cz - 0.03), (0.135, 0.17, 0.115), pelaje, "cabeza", 32))
    partes.append(esfera("nariz", (0, -0.31, cz - 0.01), (0.10, 0.035, 0.06), oscuro, "cabeza"))
    for s in (1, -1):
        partes.append(esfera(f"fosa_{s}", (s * 0.04, -0.34, cz), (0.016, 0.01, 0.012), ojo, "cabeza", 10))
        partes.append(esfera(f"ojo_{s}", (s * 0.10, -0.08, cz + 0.07), (0.03, 0.024, 0.03), ojo, "cabeza", 16))
        partes.append(esfera(f"brillo_{s}", (s * 0.092, -0.102, cz + 0.082), (0.009, 0.006, 0.009), brillo_ojo, "cabeza", 8))
        partes.append(esfera(f"oreja_{s}", (s * 0.12, 0.08, cz + 0.13), (0.045, 0.025, 0.05), pelaje, "cabeza", 12))
        partes.append(esfera(f"oreja_int_{s}", (s * 0.12, 0.06, cz + 0.13), (0.028, 0.012, 0.032), oscuro, "cabeza", 10))
        # Cuerno en dos tramos: hacia afuera y luego hacia arriba.
        base, codo, punta = Vector((s * 0.09, 0.0, cz + 0.12)), Vector((s * 0.18, -0.01, cz + 0.16)), \
            Vector((s * 0.22, -0.02, cz + 0.25))
        partes.extend(capsula(f"cuerno_base_{s}", base, codo, 0.028, cuerno, "cabeza", 0.022))
        partes.append(cono(f"cuerno_punta_{s}", codo, punta, 0.022, cuerno, "cabeza"))
    for i, (dx, dz) in enumerate(((0, 0.16), (0.03, 0.15), (-0.03, 0.15))):  # mechón
        partes.append(esfera(f"mechon_{i}", (dx, 0.0, cz + dz), (0.03, 0.03, 0.035), oscuro, "cabeza", 12))

    for lado, s in LADOS.items():
        a = articulaciones(lado)
        # Brazos cortos y regordetes, con una pulsera neón.
        partes.extend(capsula(f"brazo_{lado}", a["hombro"], a["codo"], 0.055, pelaje, f"brazo_{lado}", 0.048))
        partes.extend(capsula(f"antebrazo_{lado}", a["codo"], a["muneca"], 0.048, pelaje, f"antebrazo_{lado}", 0.042))
        partes.append(esfera(f"mano_{lado}", a["muneca"] + Vector((0, 0, -0.035)), (0.05, 0.045, 0.05), oscuro,
                             f"antebrazo_{lado}", 16))
        partes.append(toro(f"pulsera_{lado}", a["muneca"] + Vector((0, 0, 0.03)), 0.045, 0.012, neon,
                           f"antebrazo_{lado}"))
        # Piernas con su propio material (la que se fortalece cambia de aspecto) y pezuñas.
        partes.extend(capsula(f"muslo_{lado}", a["cadera"], a["rodilla"], 0.085, piernas[lado], f"muslo_{lado}", 0.065))
        partes.extend(capsula(f"pierna_{lado}", a["rodilla"], a["tobillo"], 0.065, piernas[lado], f"pierna_{lado}", 0.05))
        # Pie unido al tobillo (si no, al doblar la rodilla la pezuña se ve suelta) y pezuña en la punta.
        partes.extend(capsula(f"pie_{lado}", a["tobillo"], a["punta"], 0.05, piernas[lado], f"pie_{lado}", 0.045))
        partes.append(esfera(f"pezuna_{lado}", a["punta"] + Vector((0, 0.02, 0.005)), (0.062, 0.07, 0.04), oscuro,
                             f"pie_{lado}", 20))

    cuerpo = unir(partes, "toribara")
    pegar_al_esqueleto(cuerpo, esqueleto)
    # Ninguna pieza puede quedar suelta: todo lo que no es esqueleto, vendas o banda es del cuerpo.
    sueltas = [o.name for o in bpy.data.objects if o.type == "MESH" and o is not cuerpo]
    assert not sueltas, f"Piezas sin unir al personaje: {sueltas}"

    # Vendas: bandas anchas que se superponen alrededor de la pierna, levemente inclinadas
    # (como una venda enrollada), en dos versiones: completa y a medio quitar.
    for lado, s in LADOS.items():
        a = articulaciones(lado)
        anillos_completa, anillos_parcial = [], []
        for i in range(4):
            t = (i + 0.5) / 4
            centro = a["cadera"].lerp(a["rodilla"], t)
            eje = (0.12 * s * (1 if i % 2 else -1), 0, 1)
            anillos_completa.append(toro(f"venda_m{i}_{lado}", centro, 0.078 - 0.018 * t, 0.014, venda,
                                         f"muslo_{lado}", eje=eje, alto=2.6))
        for i in range(4):
            t = (i + 0.5) / 4
            centro = a["rodilla"].lerp(a["tobillo"], t)
            radio = 0.06 - 0.013 * t
            eje = (0.12 * s * (1 if i % 2 else -1), 0, 1)
            anillos_completa.append(toro(f"venda_p{i}_{lado}", centro, radio, 0.013, venda, f"pierna_{lado}",
                                         eje=eje, alto=2.6))
            if i >= 2:
                anillos_parcial.append(toro(f"venda_pp{i}_{lado}", centro, radio, 0.013, venda, f"pierna_{lado}",
                                            eje=eje, alto=2.6))
        for nombre, anillos in ((f"venda_completa_{lado}", anillos_completa), (f"venda_parcial_{lado}", anillos_parcial)):
            obj = unir(anillos, nombre)
            pegar_al_esqueleto(obj, esqueleto)

    # Banda de entrenador (solo la lleva el guía).
    obj = toro("banda_entrenador", (0, 0.02, cz + 0.08), 0.165, 0.02, banda, "cabeza", eje=(0, 0.25, 1), alto=1.6)
    obj.name = "banda_entrenador"
    pegar_al_esqueleto(obj, esqueleto)


# --- vistas previas ------------------------------------------------------------------
def vistas_previas(carpeta: Path) -> None:
    carpeta.mkdir(parents=True, exist_ok=True)
    escena = bpy.context.scene
    escena.render.engine = "BLENDER_WORKBENCH"
    escena.display.shading.light = "STUDIO"
    escena.display.shading.color_type = "MATERIAL"
    escena.display.shading.show_shadows = True
    escena.render.resolution_x = escena.render.resolution_y = 700
    escena.render.film_transparent = False
    datos = bpy.data.cameras.new("camara_previa")
    camara = bpy.data.objects.new("camara_previa", datos)
    escena.collection.objects.link(camara)
    escena.camera = camara
    objetivo = Vector((0, 0, 0.64))
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
            rad = math.radians(angulo)
            camara.location = objetivo + Vector((math.sin(rad) * 2.7, -math.cos(rad) * 2.7, 0.25))
            camara.rotation_mode = "QUATERNION"
            camara.rotation_quaternion = (objetivo - camara.location).to_track_quat("-Z", "Y")
            escena.render.filepath = str(carpeta / f"toribara_{variante}_{nombre}.png")
            bpy.ops.render.render(write_still=True)
    for o in opcionales:
        o.hide_render = False
    bpy.data.objects.remove(camara)


def main() -> None:
    argumentos = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    limpiar_escena()
    esqueleto = crear_esqueleto()
    crear_personaje(esqueleto)
    SALIDA_GLB.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(SALIDA_BLEND))
    bpy.ops.export_scene.gltf(filepath=str(SALIDA_GLB), export_format="GLB")
    print(f"OK {SALIDA_GLB}")
    if argumentos:
        vistas_previas(Path(argumentos[0]))


main()
