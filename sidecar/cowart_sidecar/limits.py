from __future__ import annotations

from collections import deque
from contextlib import asynccontextmanager
import asyncio
import time

from fastapi import HTTPException


class RequestQueue:
    def __init__(self, max_waiting: int):
        self._semaphore = asyncio.Semaphore(1)
        self._guard = asyncio.Lock()
        self._max_waiting = max_waiting
        self._active = 0
        self._waiting = 0

    @property
    def snapshot(self) -> dict[str, int]:
        return {"active": self._active, "waiting": self._waiting, "maxWaiting": self._max_waiting}

    @asynccontextmanager
    async def slot(self):
        async with self._guard:
            if self._active >= 1 and self._waiting >= self._max_waiting:
                raise HTTPException(
                    status_code=429,
                    detail={"code": "sidecar_queue_full", "message": "Sidecar queue is full."},
                )
            queued = self._active >= 1
            if queued:
                self._waiting += 1
        acquired = False
        try:
            await self._semaphore.acquire()
            acquired = True
            async with self._guard:
                if queued:
                    self._waiting -= 1
                self._active += 1
            yield
        finally:
            if acquired:
                async with self._guard:
                    self._active -= 1
                self._semaphore.release()
            elif queued:
                async with self._guard:
                    self._waiting = max(0, self._waiting - 1)


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0):
        self._limit = limit
        self._window = window_seconds
        self._events: deque[float] = deque()
        self._guard = asyncio.Lock()

    async def check(self) -> None:
        now = time.monotonic()
        async with self._guard:
            while self._events and self._events[0] <= now - self._window:
                self._events.popleft()
            if len(self._events) >= self._limit:
                raise HTTPException(
                    status_code=429,
                    detail={"code": "sidecar_rate_limited", "message": "Sidecar request rate exceeded."},
                )
            self._events.append(now)
