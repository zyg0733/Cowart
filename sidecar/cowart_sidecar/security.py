from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import hmac
import os
import secrets
import stat

from fastapi import Header, HTTPException


def ensure_token_file(path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return read_token_file(path)
    token = secrets.token_urlsafe(48)
    try:
        os.write(fd, f"{token}\n".encode("ascii"))
    finally:
        os.close(fd)
    return token


def read_token_file(path: Path) -> str:
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError("Sidecar token path must be a regular file")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("Sidecar token file permissions must be 0600")
    token = path.read_text(encoding="ascii").strip()
    if len(token) < 32:
        raise RuntimeError("Sidecar token is missing or too short")
    return token


def token_fingerprint(token: str) -> str:
    return sha256(token.encode("ascii")).hexdigest()[:12]


class BearerToken:
    def __init__(self, token: str):
        self._token = token

    async def __call__(self, authorization: str | None = Header(default=None)) -> None:
        prefix = "Bearer "
        supplied = authorization[len(prefix) :] if authorization and authorization.startswith(prefix) else ""
        if not supplied or not hmac.compare_digest(supplied, self._token):
            raise HTTPException(
                status_code=401,
                detail={"code": "invalid_sidecar_token", "message": "Valid Bearer token required."},
                headers={"WWW-Authenticate": "Bearer"},
            )
