from __future__ import annotations

from argparse import ArgumentParser
from resource import RUSAGE_SELF, getrusage
from sys import platform
from threading import Event
from time import monotonic

from PIL import Image, ImageDraw

from .api import PointPrompt, SegmentRequest
from .config import Settings
from .models import ModelManager


def peak_rss_mib() -> float:
    raw = getrusage(RUSAGE_SELF).ru_maxrss
    bytes_used = raw if platform == "darwin" else raw * 1024
    return bytes_used / (1024 * 1024)


def fixture_image() -> Image.Image:
    image = Image.new("RGB", (96, 96), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 18, 75, 78), fill=(35, 90, 210))
    draw.ellipse((34, 30, 61, 57), fill=(240, 190, 40))
    return image


def request_for(mode: str) -> SegmentRequest:
    common = {"mode": mode, "imageBase64": "smoke", "maxCandidates": 2}
    if mode == "point":
        return SegmentRequest(**common, points=[PointPrompt(x=48, y=48, label=1)])
    if mode == "text":
        return SegmentRequest(**common, prompt="blue rectangle")
    return SegmentRequest(**common)


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument(
        "--modes",
        default="point,text,automatic",
        help="Comma-separated subset of point,text,automatic",
    )
    args = parser.parse_args()
    modes = [item.strip() for item in args.modes.split(",") if item.strip()]
    invalid = set(modes) - {"point", "text", "automatic"}
    if invalid:
        parser.error(f"unsupported modes: {', '.join(sorted(invalid))}")

    settings = Settings.from_env()
    manager = ModelManager(settings)
    image = fixture_image()
    print({"healthBefore": manager.health(), "peakRssMiB": round(peak_rss_mib(), 1)})
    for mode in modes:
        started = monotonic()
        candidates = manager.segment(image, request_for(mode), Event())
        print(
            {
                "mode": mode,
                "device": manager.device,
                "candidates": len(candidates),
                "elapsedSeconds": round(monotonic() - started, 2),
                "peakRssMiB": round(peak_rss_mib(), 1),
            }
        )
    print({"healthAfter": manager.health()})


if __name__ == "__main__":
    main()
