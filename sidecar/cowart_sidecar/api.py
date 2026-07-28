from __future__ import annotations

from contextlib import asynccontextmanager
from threading import Event
from typing import Literal
import asyncio

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator

from . import __version__
from .config import Settings
from .images import decode_image, encode_mask
from .limits import RateLimiter, RequestQueue
from .models import ModelManager, SegmentationCancelled, candidate_summary
from .security import BearerToken, ensure_token_file, token_fingerprint


class BodyTooLarge(RuntimeError):
    pass


class BodyLimitMiddleware:
    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != "/v1/segment":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            content_length = 0
        if content_length > self.max_bytes:
            await self._reject(scope, receive, send)
            return
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise BodyTooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send)
        except BodyTooLarge:
            await self._reject(scope, receive, send)

    @staticmethod
    async def _reject(scope, receive, send):
        response = JSONResponse(
            status_code=413,
            content={
                "detail": {
                    "code": "request_too_large",
                    "message": "Request body exceeds the Sidecar limit.",
                }
            },
        )
        await response(scope, receive, send)


class PointPrompt(BaseModel):
    x: float
    y: float
    label: Literal[0, 1] = 1


class BoxPrompt(BaseModel):
    x: float
    y: float
    w: float
    h: float


class SegmentRequest(BaseModel):
    mode: Literal["point", "box", "text", "automatic"]
    imageBase64: str
    points: list[PointPrompt] = Field(default_factory=list, max_length=64)
    box: BoxPrompt | None = None
    prompt: str | None = Field(default=None, max_length=500)
    maxCandidates: int = Field(default=8, ge=1, le=8)

    @model_validator(mode="after")
    def validate_prompt(self):
        if self.mode == "point" and not self.points:
            raise ValueError("point mode requires points")
        if self.mode == "box" and self.box is None:
            raise ValueError("box mode requires box")
        if self.mode == "text" and not (self.prompt or "").strip():
            raise ValueError("text mode requires prompt")
        return self

    def normalized_box(self) -> list[float]:
        if self.box is None:
            raise ValueError("box is required")
        return [self.box.x, self.box.y, self.box.x + self.box.w, self.box.y + self.box.h]


async def _watch_disconnect(request: Request, cancelled: Event):
    while not cancelled.is_set():
        if await request.is_disconnected():
            cancelled.set()
            return
        await asyncio.sleep(0.05)


def create_app(settings: Settings | None = None, manager=None) -> FastAPI:
    settings = settings or Settings.from_env()
    token = ensure_token_file(settings.token_file)
    auth = BearerToken(token)
    queue = RequestQueue(settings.max_waiting)
    limiter = RateLimiter(settings.rate_limit_per_minute)
    manager = manager or ModelManager(settings)

    @asynccontextmanager
    async def lifespan(_app):
        stop = asyncio.Event()

        async def idle_unloader():
            while not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=5)
                except TimeoutError:
                    await asyncio.to_thread(manager.unload_if_idle)

        task = asyncio.create_task(idle_unloader())
        yield
        stop.set()
        await task

    app = FastAPI(
        title="Cowart Segmentation Sidecar",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.manager = manager
    app.state.queue = queue
    app.state.token_fingerprint = token_fingerprint(token)
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_body_bytes)

    @app.get("/v1/health", dependencies=[Depends(auth)])
    async def health():
        return {
            "ok": True,
            "version": __version__,
            "binding": {"host": settings.host, "port": settings.port},
            "queue": queue.snapshot,
            "limits": {
                "cpuThreads": settings.cpu_threads,
                "maxCandidates": settings.max_candidates,
                "unloadAfterSeconds": settings.unload_after_seconds,
            },
            "capabilities": {
                "modes": ["point", "box", "text", "automatic"],
                "cloudFallback": False,
                "publishesSegments": False,
            },
            **manager.health(),
        }

    @app.post("/v1/segment", dependencies=[Depends(auth)])
    async def segment(payload: SegmentRequest, request: Request):
        await limiter.check()
        image = decode_image(payload.imageBase64, settings.max_image_pixels)
        payload.maxCandidates = min(payload.maxCandidates, settings.max_candidates)
        cancelled = Event()
        async with queue.slot():
            watcher = asyncio.create_task(_watch_disconnect(request, cancelled))
            try:
                candidates = await asyncio.to_thread(manager.segment, image, payload, cancelled)
            except SegmentationCancelled as error:
                raise HTTPException(
                    status_code=499,
                    detail={"code": "segmentation_cancelled", "message": "Segmentation was cancelled."},
                ) from error
            finally:
                cancelled.set()
                await watcher
        return {
            "mode": payload.mode,
            "naturalSize": {"width": image.width, "height": image.height},
            "provider": {
                "id": "cowart-sidecar",
                "runtime": "python",
                "processing": "local",
                "model": "sam2.1-hiera-tiny"
                + ("+grounding-dino-tiny" if payload.mode == "text" else ""),
                "version": __version__,
                "device": manager.health()["device"]["selected"],
            },
            "candidates": [
                {
                    **candidate_summary(candidate, index),
                    "maskBase64": encode_mask(candidate.mask),
                }
                for index, candidate in enumerate(candidates)
            ],
        }

    return app
