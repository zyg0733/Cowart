from __future__ import annotations

from base64 import b64decode, b64encode
from io import BytesIO
import binascii

from fastapi import HTTPException
from PIL import Image


def decode_image(value: str, max_pixels: int):
    if not isinstance(value, str) or not value:
        raise HTTPException(
            status_code=400,
            detail={"code": "missing_image", "message": "imageBase64 is required."},
        )
    encoded = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
    try:
        raw = b64decode(encoded, validate=True)
        image = Image.open(BytesIO(raw))
        image.load()
    except (binascii.Error, OSError, ValueError) as error:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_image", "message": "imageBase64 is not a decodable image."},
        ) from error
    if image.width * image.height > max_pixels:
        raise HTTPException(
            status_code=413,
            detail={"code": "image_too_large", "message": "Image pixel count exceeds the sidecar limit."},
        )
    return image.convert("RGB")


def encode_mask(mask) -> str:
    buffer = BytesIO()
    mask.convert("L").save(buffer, format="PNG", optimize=False)
    return b64encode(buffer.getvalue()).decode("ascii")
