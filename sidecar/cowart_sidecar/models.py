from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from threading import Event, Lock
from typing import Any
import gc
import json
import os
import time

from PIL import Image


class SegmentationCancelled(RuntimeError):
    pass


@dataclass
class Candidate:
    mask: Image.Image
    score: float
    label: str | None = None


def _mask_bbox_area(mask: Image.Image) -> tuple[dict[str, int] | None, int]:
    binary = mask.convert("L").point(lambda value: 255 if value >= 128 else 0)
    bbox = binary.getbbox()
    histogram = binary.histogram()
    area = histogram[255] if len(histogram) > 255 else 0
    if not bbox:
        return None, 0
    left, top, right, bottom = bbox
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}, area


def _iou(first: Image.Image, second: Image.Image) -> float:
    from PIL import ImageChops

    a = first.convert("1")
    b = second.convert("1")
    intersection = ImageChops.logical_and(a, b).histogram()[255]
    union = ImageChops.logical_or(a, b).histogram()[255]
    return intersection / union if union else 0.0


class ModelManager:
    def __init__(self, settings):
        self.settings = settings
        self.device = "cpu"
        self.device_fallback_reason: str | None = None
        self._torch = None
        self._sam_model = None
        self._sam_processor = None
        self._dino_model = None
        self._dino_processor = None
        self._last_used = 0.0
        self._lock = Lock()
        self._forced_cpu = False
        os.environ.setdefault("OMP_NUM_THREADS", str(settings.cpu_threads))
        os.environ.setdefault("MKL_NUM_THREADS", str(settings.cpu_threads))
        self._receipt = self._read_receipt()

    def _read_receipt(self) -> dict | None:
        path = self.settings.model_dir / "receipt.json"
        if not path.is_file():
            return None
        receipt = json.loads(path.read_text(encoding="utf-8"))
        lock_path = Path(__file__).resolve().parents[1] / "models.lock.json"
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        for key, expected in lock["models"].items():
            actual = receipt.get("models", {}).get(key)
            if not actual:
                return None
            if any(
                actual.get(field) != expected.get(field)
                for field in ("repoId", "revision", "weightFile", "weightSha256")
            ):
                return None
            if not (self.settings.model_dir / key / expected["weightFile"]).is_file():
                return None
        return receipt

    def health(self) -> dict[str, Any]:
        return {
            "device": {
                "requested": self.settings.device,
                "selected": self.device,
                "fallbackReason": self.device_fallback_reason,
            },
            "models": {
                "installed": self._receipt is not None,
                "loaded": self._sam_model is not None,
                "sam2": self._receipt_model("sam2"),
                "groundingDino": self._receipt_model("groundingDino"),
            },
        }

    def _receipt_model(self, key: str) -> dict | None:
        model = self._receipt.get("models", {}).get(key) if self._receipt else None
        if not model:
            return None
        return {
            "repoId": model.get("repoId"),
            "revision": model.get("revision"),
            "weightSha256": model.get("weightSha256"),
        }

    def _select_device(self, torch) -> str:
        requested = self.settings.device
        if self._forced_cpu:
            return "cpu"
        self.device_fallback_reason = None
        if requested in {"auto", "cuda"} and torch.cuda.is_available():
            return "cuda"
        if requested in {"auto", "mps"} and getattr(torch.backends, "mps", None):
            if torch.backends.mps.is_available():
                return "mps"
        if requested != "cpu":
            self.device_fallback_reason = f"{requested} unavailable; using CPU"
        return "cpu"

    def _ensure_loaded(self, needs_dino: bool) -> None:
        with self._lock:
            if self._receipt is None:
                raise RuntimeError(
                    "Models are not installed. Run npm run sidecar:setup explicitly."
                )
            import torch
            from transformers import (
                AutoModelForZeroShotObjectDetection,
                AutoProcessor,
                Sam2Model,
                Sam2Processor,
            )

            torch.set_num_threads(self.settings.cpu_threads)
            self.device = self._select_device(torch)
            self._torch = torch
            try:
                self._load_models(
                    needs_dino,
                    Sam2Model,
                    Sam2Processor,
                    AutoProcessor,
                    AutoModelForZeroShotObjectDetection,
                )
            except RuntimeError as error:
                if self.device == "cpu":
                    raise
                failed_device = self.device
                self._clear_models()
                self._forced_cpu = True
                self.device = "cpu"
                self.device_fallback_reason = (
                    f"{failed_device} initialization failed; using CPU: {str(error)[:160]}"
                )
                self._load_models(
                    needs_dino,
                    Sam2Model,
                    Sam2Processor,
                    AutoProcessor,
                    AutoModelForZeroShotObjectDetection,
                )
            self._last_used = time.monotonic()

    def _load_models(
        self,
        needs_dino,
        Sam2Model,
        Sam2Processor,
        AutoProcessor,
        AutoModelForZeroShotObjectDetection,
    ):
        if self._sam_model is None:
            sam_dir = self.settings.model_dir / "sam2"
            self._sam_processor = Sam2Processor.from_pretrained(
                sam_dir, local_files_only=True
            )
            self._sam_model = Sam2Model.from_pretrained(
                sam_dir, local_files_only=True
            ).to(self.device)
            self._sam_model.eval()
        if needs_dino and self._dino_model is None:
            dino_dir = self.settings.model_dir / "groundingDino"
            self._dino_processor = AutoProcessor.from_pretrained(
                dino_dir, local_files_only=True
            )
            self._dino_model = AutoModelForZeroShotObjectDetection.from_pretrained(
                dino_dir, local_files_only=True
            ).to(self.device)
            self._dino_model.eval()

    def _clear_models(self):
        self._sam_model = None
        self._sam_processor = None
        self._dino_model = None
        self._dino_processor = None

    def unload_if_idle(self) -> bool:
        with self._lock:
            if self._sam_model is None:
                return False
            if time.monotonic() - self._last_used < self.settings.unload_after_seconds:
                return False
            self._clear_models()
            gc.collect()
            if self._torch and self.device == "cuda":
                self._torch.cuda.empty_cache()
            if self._torch and self.device == "mps":
                self._torch.mps.empty_cache()
            return True

    def segment(self, image, request, cancel: Event) -> list[Candidate]:
        mode = request.mode
        self._ensure_loaded(needs_dino=mode == "text")
        try:
            return self._segment_loaded(image, request, cancel)
        except RuntimeError as error:
            if self.device == "cpu":
                raise
            failed_device = self.device
            with self._lock:
                self._clear_models()
                self._forced_cpu = True
                self.device = "cpu"
                self.device_fallback_reason = (
                    f"{failed_device} inference failed; using CPU: {str(error)[:160]}"
                )
                gc.collect()
            self._ensure_loaded(needs_dino=mode == "text")
            return self._segment_loaded(image, request, cancel)

    def _segment_loaded(self, image, request, cancel: Event) -> list[Candidate]:
        mode = request.mode
        if cancel.is_set():
            raise SegmentationCancelled()
        if mode == "text":
            boxes, labels, scores = self._detect_boxes(image, request.prompt, cancel)
            candidates = []
            for box, label, score in zip(boxes, labels, scores, strict=False):
                candidates.extend(self._sam_candidates(image, box=box, label=label, score_scale=score))
                if cancel.is_set():
                    raise SegmentationCancelled()
        elif mode == "box":
            box = request.normalized_box()
            candidates = self._sam_candidates(image, box=box)
        elif mode == "automatic":
            candidates = self._automatic_candidates(image, request.maxCandidates, cancel)
        else:
            points = [[point.x, point.y] for point in request.points]
            labels = [point.label for point in request.points]
            candidates = self._sam_candidates(image, points=points, labels=labels)
        self._last_used = time.monotonic()
        return self._dedupe(candidates, request.maxCandidates)

    def _to_device(self, inputs):
        return {
            key: value.to(self.device) if hasattr(value, "to") else value
            for key, value in inputs.items()
        }

    def _sam_candidates(
        self,
        image,
        *,
        points=None,
        labels=None,
        box=None,
        label=None,
        score_scale=1.0,
    ) -> list[Candidate]:
        kwargs = {}
        if points is not None:
            kwargs["input_points"] = [[points]]
            kwargs["input_labels"] = [[labels]]
        if box is not None:
            kwargs["input_boxes"] = [[box]]
        inputs = self._sam_processor(images=image, return_tensors="pt", **kwargs)
        device_inputs = self._to_device(inputs)
        with self._torch.inference_mode():
            outputs = self._sam_model(**device_inputs, multimask_output=True)
        masks = self._sam_processor.post_process_masks(
            outputs.pred_masks.cpu(),
            inputs["original_sizes"],
        )[0]
        scores = outputs.iou_scores.detach().cpu().reshape(-1).tolist()
        candidates = []
        for index, tensor in enumerate(masks.reshape(-1, masks.shape[-2], masks.shape[-1])):
            values = tensor.detach().cpu().numpy()
            mask = Image.fromarray((values > 0).astype("uint8") * 255, mode="L")
            candidates.append(
                Candidate(
                    mask=mask,
                    score=float(scores[index] if index < len(scores) else 0.0) * float(score_scale),
                    label=label,
                )
            )
        return candidates

    def _detect_boxes(self, image, prompt: str, cancel: Event):
        text = prompt.strip()
        if not text.endswith("."):
            text += "."
        inputs = self._dino_processor(images=image, text=text, return_tensors="pt")
        device_inputs = self._to_device(inputs)
        with self._torch.inference_mode():
            outputs = self._dino_model(**device_inputs)
        if cancel.is_set():
            raise SegmentationCancelled()
        result = self._dino_processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            threshold=0.25,
            text_threshold=0.2,
            target_sizes=[(image.height, image.width)],
        )[0]
        boxes = result["boxes"].detach().cpu().tolist()
        labels = result.get("text_labels", [prompt] * len(boxes))
        scores = result["scores"].detach().cpu().tolist()
        return boxes, labels, scores

    def _automatic_candidates(self, image, limit: int, cancel: Event) -> list[Candidate]:
        columns = 4
        rows = 4
        candidates = []
        for row in range(rows):
            for column in range(columns):
                if cancel.is_set():
                    raise SegmentationCancelled()
                point = [
                    (column + 0.5) * image.width / columns,
                    (row + 0.5) * image.height / rows,
                ]
                candidates.extend(
                    self._sam_candidates(image, points=[point], labels=[1])
                )
                candidates = self._dedupe(candidates, max(limit * 2, limit))
        return candidates

    @staticmethod
    def _dedupe(candidates: list[Candidate], limit: int) -> list[Candidate]:
        ranked = []
        for candidate in sorted(candidates, key=lambda item: item.score, reverse=True):
            _, area = _mask_bbox_area(candidate.mask)
            if area <= 0:
                continue
            if any(_iou(candidate.mask, existing.mask) >= 0.9 for existing in ranked):
                continue
            ranked.append(candidate)
            if len(ranked) >= limit:
                break
        return ranked


def candidate_summary(candidate: Candidate, index: int) -> dict[str, Any]:
    bbox, area = _mask_bbox_area(candidate.mask)
    return {
        "candidateId": f"candidate:{index + 1}",
        "score": round(max(0.0, min(1.0, candidate.score)), 6),
        "label": candidate.label,
        "bbox": bbox,
        "area": area,
    }
