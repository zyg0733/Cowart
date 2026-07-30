from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    home: Path
    token_file: Path
    model_dir: Path
    device: str
    cpu_threads: int
    max_waiting: int
    max_candidates: int
    max_image_pixels: int
    max_body_bytes: int
    unload_after_seconds: int
    rate_limit_per_minute: int

    @classmethod
    def from_env(cls) -> "Settings":
        host = os.environ.get("COWART_SIDECAR_HOST", "127.0.0.1")
        if host not in {"127.0.0.1", "::1", "localhost"}:
            raise ValueError("COWART_SIDECAR_HOST must be loopback")
        home = Path(
            os.environ.get(
                "COWART_SIDECAR_HOME",
                str(Path.home() / ".cowart" / "sidecar"),
            )
        ).expanduser().resolve()
        token_file = Path(
            os.environ.get("COWART_SIDECAR_TOKEN_FILE", str(home / "token"))
        ).expanduser().resolve()
        model_dir = Path(
            os.environ.get("COWART_SIDECAR_MODEL_DIR", str(home / "models"))
        ).expanduser().resolve()
        device = os.environ.get("COWART_SIDECAR_DEVICE", "auto").strip().lower()
        if device not in {"auto", "mps", "cuda", "cpu"}:
            raise ValueError("COWART_SIDECAR_DEVICE must be auto, mps, cuda, or cpu")
        return cls(
            host=host,
            port=_bounded_int("COWART_SIDECAR_PORT", 43219, 1, 65535),
            home=home,
            token_file=token_file,
            model_dir=model_dir,
            device=device,
            cpu_threads=_bounded_int("COWART_SIDECAR_CPU_THREADS", 4, 1, 4),
            max_waiting=_bounded_int("COWART_SIDECAR_MAX_WAITING", 2, 0, 2),
            max_candidates=_bounded_int("COWART_SIDECAR_MAX_CANDIDATES", 8, 1, 8),
            max_image_pixels=_bounded_int(
                "COWART_SIDECAR_MAX_IMAGE_PIXELS", 40_000_000, 1_000_000, 80_000_000
            ),
            max_body_bytes=_bounded_int(
                "COWART_SIDECAR_MAX_BODY_BYTES", 64 * 1024 * 1024, 1024, 96 * 1024 * 1024
            ),
            unload_after_seconds=_bounded_int(
                "COWART_SIDECAR_UNLOAD_SECONDS", 300, 30, 3600
            ),
            rate_limit_per_minute=_bounded_int(
                "COWART_SIDECAR_RATE_LIMIT", 30, 1, 120
            ),
        )
