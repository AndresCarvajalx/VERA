"""Modelo de datos (SQLAlchemy). Ningún dato identifica a la persona: solo un código anónimo.

Entidades del documento de arquitectura implementadas por ahora: Paciente, Consentimiento,
Ejercicio, ObjetivoAngular, Sesion, ResultadoEjercicio, Repeticion y MedicionReferencia.
Usuario (roles), Nivel y SerieLandmarks llegan con el panel del fisioterapeuta y el OE4.
"""
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def ahora() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Paciente(Base):
    __tablename__ = "paciente"
    id: Mapped[int] = mapped_column(primary_key=True)
    codigo: Mapped[str] = mapped_column(String(20), unique=True)
    creado: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=ahora)
    consentimientos: Mapped[list["Consentimiento"]] = relationship(back_populates="paciente")
    sesiones: Mapped[list["Sesion"]] = relationship(back_populates="paciente")

    @property
    def consentimiento_vigente(self) -> bool:
        return any(c.autoriza_datos_sensibles and not c.revocado for c in self.consentimientos)


class Consentimiento(Base):
    """Consentimiento informado y autorización de datos sensibles (Ley 1581 de 2012)."""
    __tablename__ = "consentimiento"
    id: Mapped[int] = mapped_column(primary_key=True)
    paciente_id: Mapped[int] = mapped_column(ForeignKey("paciente.id"))
    version_texto: Mapped[str] = mapped_column(String(20))
    autoriza_datos_sensibles: Mapped[bool] = mapped_column(Boolean)
    revocado: Mapped[bool] = mapped_column(Boolean, default=False)
    fecha: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=ahora)
    paciente: Mapped[Paciente] = relationship(back_populates="consentimientos")


class Ejercicio(Base):
    """Copia del catálogo de config/reglas_rom.json, para que los resultados lo referencien."""
    __tablename__ = "ejercicio"
    clave: Mapped[str] = mapped_column(String(40), primary_key=True)
    nombre: Mapped[str] = mapped_column(String(80))
    articulacion: Mapped[str] = mapped_column(String(20))
    posicion: Mapped[str] = mapped_column(String(20))
    direccion: Mapped[str] = mapped_column(String(10))
    meta_por_defecto: Mapped[float] = mapped_column(Float)
    max_fisiologico: Mapped[float] = mapped_column(Float)
    min_fisiologico: Mapped[float] = mapped_column(Float)


class ObjetivoAngular(Base):
    """Meta individualizada. La fija o aprueba el fisioterapeuta; el sistema nunca la cambia solo."""
    __tablename__ = "objetivo_angular"
    id: Mapped[int] = mapped_column(primary_key=True)
    paciente_id: Mapped[int] = mapped_column(ForeignKey("paciente.id"))
    ejercicio_clave: Mapped[str] = mapped_column(ForeignKey("ejercicio.clave"))
    lado: Mapped[str] = mapped_column(String(3))
    meta: Mapped[float] = mapped_column(Float)
    repeticiones: Mapped[int] = mapped_column(Integer)
    tiempo_sostenido_ms: Mapped[int] = mapped_column(Integer)
    aprobado_por: Mapped[str] = mapped_column(String(80))
    vigente: Mapped[bool] = mapped_column(Boolean, default=True)
    fecha: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=ahora)


class Sesion(Base):
    __tablename__ = "sesion"
    id: Mapped[int] = mapped_column(primary_key=True)
    paciente_id: Mapped[int] = mapped_column(ForeignKey("paciente.id"))
    inicio: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=ahora)
    fin: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    latencia_promedio_ms: Mapped[float | None] = mapped_column(Float)
    paciente: Mapped[Paciente] = relationship(back_populates="sesiones")
    resultados: Mapped[list["ResultadoEjercicio"]] = relationship(back_populates="sesion")


class ResultadoEjercicio(Base):
    """Lo medido al terminar una evaluación de rango o un ejercicio del juego. Sin imágenes."""
    __tablename__ = "resultado_ejercicio"
    id: Mapped[int] = mapped_column(primary_key=True)
    sesion_id: Mapped[int] = mapped_column(ForeignKey("sesion.id"))
    ejercicio_clave: Mapped[str] = mapped_column(ForeignKey("ejercicio.clave"))
    lado: Mapped[str] = mapped_column(String(3))
    tipo: Mapped[str] = mapped_column(String(12))  # "calibracion" o "juego"
    meta: Mapped[float | None] = mapped_column(Float)
    angulo_max: Mapped[float | None] = mapped_column(Float)
    angulo_min: Mapped[float | None] = mapped_column(Float)
    rango: Mapped[float | None] = mapped_column(Float)
    mejor: Mapped[float | None] = mapped_column(Float)  # el valor más cercano a la meta
    reposo: Mapped[float | None] = mapped_column(Float)  # posición de partida del jugador
    validas: Mapped[int | None] = mapped_column(Integer)
    intentadas: Mapped[int | None] = mapped_column(Integer)
    compensaciones: Mapped[int] = mapped_column(Integer, default=0)
    completo: Mapped[bool] = mapped_column(Boolean)
    fps_promedio: Mapped[float | None] = mapped_column(Float)
    # Calibración: diferencia entre los mejores intentos y si cumplieron la dispersión máxima.
    dispersion: Mapped[float | None] = mapped_column(Float)
    consistente: Mapped[bool | None] = mapped_column(Boolean)
    fecha: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=ahora)
    sesion: Mapped[Sesion] = relationship(back_populates="resultados")
    repeticiones: Mapped[list["Repeticion"]] = relationship(back_populates="resultado")


class MedicionReferencia(Base):
    """CU-14 / OE4: el ángulo del goniómetro del fisioterapeuta junto al que midió el sistema
    en el mismo momento, para calcular el error absoluto medio."""
    __tablename__ = "medicion_referencia"
    id: Mapped[int] = mapped_column(primary_key=True)
    sesion_id: Mapped[int] = mapped_column(ForeignKey("sesion.id"))
    articulacion: Mapped[str] = mapped_column(String(20))  # rodilla, cadera o tobillo
    lado: Mapped[str] = mapped_column(String(3))
    angulo_goniometro: Mapped[float] = mapped_column(Float)
    angulo_sistema: Mapped[float] = mapped_column(Float)  # mediana del último segundo, quieto
    dispersion_sistema: Mapped[float] = mapped_column(Float)  # desviación en ese segundo
    evaluador: Mapped[str] = mapped_column(String(80))
    fecha: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=ahora)


class Repeticion(Base):
    """Una repetición del juego o, en una calibración, un intento (motivo = "intento")."""
    __tablename__ = "repeticion"
    __table_args__ = (UniqueConstraint("resultado_id", "numero"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    resultado_id: Mapped[int] = mapped_column(ForeignKey("resultado_ejercicio.id"))
    numero: Mapped[int] = mapped_column(Integer)
    angulo_pico: Mapped[float] = mapped_column(Float)
    sostenido_ms: Mapped[int] = mapped_column(Integer)
    valida: Mapped[bool] = mapped_column(Boolean)
    motivo: Mapped[str | None] = mapped_column(String(20))
    resultado: Mapped[ResultadoEjercicio] = relationship(back_populates="repeticiones")
