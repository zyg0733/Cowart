from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import argparse
import json
import os

from huggingface_hub import snapshot_download

from .config import Settings
from .security import ensure_token_file, token_fingerprint


def hash_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def setup_models(settings: Settings, lock_file: Path) -> dict:
    lock = json.loads(lock_file.read_text(encoding="utf-8"))
    settings.model_dir.mkdir(parents=True, exist_ok=True)
    receipt = {"schemaVersion": 1, "models": {}}
    for key, model in lock["models"].items():
        local_dir = settings.model_dir / key
        snapshot_download(
            repo_id=model["repoId"],
            revision=model["revision"],
            local_dir=local_dir,
            allow_patterns=model["allowPatterns"],
        )
        weight_path = local_dir / model["weightFile"]
        actual = hash_file(weight_path)
        expected = model["weightSha256"]
        if actual != expected:
            raise RuntimeError(
                f"{key} checksum mismatch: expected {expected}, received {actual}"
            )
        receipt["models"][key] = {
            "repoId": model["repoId"],
            "revision": model["revision"],
            "weightFile": model["weightFile"],
            "weightSha256": actual,
            "localDir": str(local_dir),
        }
    receipt_path = settings.model_dir / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--lock-file",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "models.lock.json",
    )
    parser.add_argument("--token-only", action="store_true")
    args = parser.parse_args()
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    settings = Settings.from_env()
    token = ensure_token_file(settings.token_file)
    print(f"Sidecar token ready ({token_fingerprint(token)}) at {settings.token_file}")
    if not args.token_only:
        receipt = setup_models(settings, args.lock_file.resolve())
        for key, model in receipt["models"].items():
            print(f"Verified {key} {model['revision']} {model['weightSha256']}")


if __name__ == "__main__":
    main()
