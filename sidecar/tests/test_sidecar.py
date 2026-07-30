from __future__ import annotations

from base64 import b64encode
from io import BytesIO
from pathlib import Path
from threading import Event
import asyncio
import os
import stat
import tempfile
import time
import tomllib
import unittest

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from cowart_sidecar.api import create_app
from cowart_sidecar.config import Settings
from cowart_sidecar.limits import RateLimiter, RequestQueue
from cowart_sidecar.models import Candidate, SegmentationCancelled


def image_base64() -> str:
    buffer = BytesIO()
    Image.new("RGB", (4, 3), "white").save(buffer, "PNG")
    return b64encode(buffer.getvalue()).decode("ascii")


class FakeManager:
    def __init__(self):
        self.cancel = False

    def health(self):
        return {
            "device": {"requested": "cpu", "selected": "cpu", "fallbackReason": None},
            "models": {"installed": True, "loaded": False, "sam2": {}, "groundingDino": {}},
        }

    def unload_if_idle(self):
        return False

    def segment(self, image, request, cancelled: Event):
        if self.cancel:
            raise SegmentationCancelled()
        mask = Image.new("L", image.size, 0)
        mask.putpixel((1, 1), 255)
        return [Candidate(mask=mask, score=0.9, label=request.prompt)]


def settings(home: Path, *, rate=30, waiting=2, max_body=1024 * 1024) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=43219,
        home=home,
        token_file=home / "token",
        model_dir=home / "models",
        device="cpu",
        cpu_threads=4,
        max_waiting=waiting,
        max_candidates=8,
        max_image_pixels=1_000_000,
        max_body_bytes=max_body,
        unload_after_seconds=300,
        rate_limit_per_minute=rate,
    )


class SidecarApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.manager = FakeManager()
        self.app = create_app(settings(self.home), self.manager)
        self.client = TestClient(self.app)
        self.token = (self.home / "token").read_text().strip()
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_token_is_0600_and_auth_is_required(self):
        self.assertEqual(stat.S_IMODE((self.home / "token").stat().st_mode), 0o600)
        self.assertEqual(self.client.get("/v1/health").status_code, 401)
        response = self.client.get("/v1/health", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["capabilities"]["cloudFallback"])

    def test_point_segmentation_returns_candidate_without_publishing(self):
        response = self.client.post(
            "/v1/segment",
            headers=self.headers,
            json={
                "mode": "point",
                "imageBase64": image_base64(),
                "points": [{"x": 1, "y": 1, "label": 1}],
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["naturalSize"], {"width": 4, "height": 3})
        self.assertEqual(len(body["candidates"]), 1)
        self.assertNotIn("segmentId", body["candidates"][0])
        self.assertEqual(body["provider"]["processing"], "local")

    def test_cancelled_inference_is_explicit(self):
        self.manager.cancel = True
        response = self.client.post(
            "/v1/segment",
            headers=self.headers,
            json={
                "mode": "automatic",
                "imageBase64": image_base64(),
                "maxCandidates": 1,
            },
        )
        self.assertEqual(response.status_code, 499)
        self.assertEqual(response.json()["detail"]["code"], "segmentation_cancelled")

    def test_request_body_limit_precedes_json_parsing(self):
        app = create_app(settings(self.home, max_body=128), self.manager)
        client = TestClient(app)
        try:
            response = client.post(
                "/v1/segment",
                headers=self.headers,
                content=b"x" * 129,
            )
        finally:
            client.close()
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"]["code"], "request_too_large")


class LimitTests(unittest.IsolatedAsyncioTestCase):
    async def test_rate_limiter_rejects_over_limit(self):
        limiter = RateLimiter(1, 60)
        await limiter.check()
        with self.assertRaises(HTTPException) as context:
            await limiter.check()
        self.assertEqual(context.exception.status_code, 429)

    async def test_queue_allows_one_active_and_two_waiting(self):
        queue = RequestQueue(2)
        release = asyncio.Event()
        entered = []

        async def occupy(name):
            async with queue.slot():
                entered.append(name)
                await release.wait()

        first = asyncio.create_task(occupy("first"))
        await asyncio.sleep(0)
        second = asyncio.create_task(occupy("second"))
        third = asyncio.create_task(occupy("third"))
        await asyncio.sleep(0)
        with self.assertRaises(HTTPException) as context:
            async with queue.slot():
                pass
        self.assertEqual(context.exception.status_code, 429)
        release.set()
        await asyncio.gather(first, second, third)
        self.assertEqual(entered, ["first", "second", "third"])


class ReleaseContractTests(unittest.TestCase):
    def test_python_and_model_dependencies_are_exactly_pinned(self):
        project = tomllib.loads(
            (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(project["project"]["requires-python"], "==3.11.*")
        self.assertIn("fastapi==0.140.0", project["project"]["dependencies"])
        self.assertIn("uvicorn==0.51.0", project["project"]["dependencies"])
        self.assertEqual(
            set(project["project"]["optional-dependencies"]["models"]),
            {
                "torch==2.13.0",
                "torchvision==0.28.0",
                "transformers==5.14.1",
            },
        )


if __name__ == "__main__":
    unittest.main()
