"""Cambio de cámara sin tocar hardware: se reemplaza la apertura de cámaras por una falsa."""
import numpy as np
import pytest

from app import ajustes, captura


class CamaraFalsa:
    def __init__(self, fuente, abre: bool):
        self.fuente, self.abre = fuente, abre

    def isOpened(self):
        return self.abre

    def read(self):
        return (True, np.zeros((480, 640, 3), np.uint8)) if self.abre else (False, None)

    def set(self, *_):
        return True

    def release(self):
        pass


@pytest.fixture
def camaras(monkeypatch):
    """Solo existen la cámara 0 y la URL del celular."""
    disponibles = {0, "http://192.168.1.20:8080/video"}
    monkeypatch.setattr(captura, "abrir_captura", lambda f: CamaraFalsa(f, f in disponibles))
    return disponibles


class EstimadorNulo:
    def detectar(self, *_):
        return None

    def cerrar(self):
        pass


def test_url_de_camara():
    assert captura.es_url_de_camara("http://192.168.1.20:8080/video")
    assert captura.es_url_de_camara("rtsp://10.0.0.5/stream")
    assert not captura.es_url_de_camara("file:///etc/passwd")
    assert not captura.es_url_de_camara(1)


def test_listar_camaras_no_abre_la_que_esta_en_uso(camaras):
    lista = captura.listar_camaras(excluir=0, maximo=3)
    assert lista == [{"indice": 0, "en_uso": True}]  # la 1 y la 2 no existen


def test_cambiar_a_la_camara_del_celular(camaras):
    bucle = captura.BucleCaptura(EstimadorNulo(), lambda m: None, indice_camara=0)
    lector = captura.LectorCamara(0, 640, 480)
    assert lector.abrir()
    futuro = bucle.cambiar_camara("http://192.168.1.20:8080/video")
    lector = bucle._atender_cambio_de_camara(lector)
    assert futuro.result(timeout=1) is True
    assert bucle.fuente == "http://192.168.1.20:8080/video"
    lector.cerrar()


def test_si_la_nueva_no_abre_sigue_la_anterior(camaras):
    bucle = captura.BucleCaptura(EstimadorNulo(), lambda m: None, indice_camara=0)
    lector = captura.LectorCamara(0, 640, 480)
    lector.abrir()
    futuro = bucle.cambiar_camara(3)
    lector = bucle._atender_cambio_de_camara(lector)
    assert futuro.result(timeout=1) is False
    assert bucle.fuente == 0 and lector is not None
    lector.cerrar()


def test_ajustes_se_guardan_y_se_leen(tmp_path):
    ruta = tmp_path / "ajustes.json"
    assert ajustes.leer(ruta) == {}
    ajustes.guardar({"camara": "http://192.168.1.20:8080/video"}, ruta)
    ajustes.guardar({"otro": 1}, ruta)
    assert ajustes.leer(ruta) == {"camara": "http://192.168.1.20:8080/video", "otro": 1}
