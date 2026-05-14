"""Per-image angle cache: one folder per source image, subfolders angle_000..angle_095."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
import uuid
from pathlib import Path


def _default_library_root(service_dir: str) -> Path:
    env = os.environ.get("MULTI_ANGLE_LIBRARY_DIR", "").strip()
    if env:
        return Path(env).resolve()
    return Path(service_dir) / "angle_library"


def file_hash_short(path: str | Path, nbytes: int = 65536, digest_len: int = 8) -> str:
    p = Path(path)
    h = hashlib.sha256()
    with open(p, "rb") as f:
        chunk = f.read(nbytes)
        h.update(chunk)
    return h.hexdigest()[:digest_len]


def sanitize_stem(name: str, max_len: int = 80) -> str:
    base = Path(name).stem
    s = re.sub(r"[^\w\-]+", "_", base, flags=re.UNICODE)
    s = s.strip("_") or "image"
    return s[:max_len]


def image_library_key(
    *,
    basename: str,
    content_hash: str,
    library_key: str | None = None,
) -> str:
    if library_key:
        safe = re.sub(r"[^\w\-]+", "_", library_key.strip(), flags=re.UNICODE)
        return (safe or "library")[:120]
    stem = sanitize_stem(basename)
    return f"{stem}_{content_hash}"


def library_root_for_service(service_dir: str) -> Path:
    return _default_library_root(service_dir)


def image_library_dir(
    service_dir: str,
    *,
    source_path: str | Path,
    library_key: str | None = None,
) -> Path:
    root = library_root_for_service(service_dir)
    p = Path(source_path).resolve()
    h = file_hash_short(p)
    key = image_library_key(basename=p.name, content_hash=h, library_key=library_key)
    return root / key


def ensure_starting_image(lib_dir: Path, source_path: str | Path) -> None:
    lib_dir.mkdir(parents=True, exist_ok=True)
    dst = lib_dir / f"starting_image{Path(source_path).suffix}"
    if not dst.is_file():
        shutil.copy2(source_path, dst)


def angle_subdir(lib_dir: Path, angle_id: int) -> Path:
    return lib_dir / f"angle_{angle_id:03d}"


def next_angle_output_path(angle_dir: Path, suffix: str = ".png") -> Path:
    angle_dir.mkdir(parents=True, exist_ok=True)
    name = f"{int(time.time())}_{uuid.uuid4().hex[:8]}{suffix}"
    return angle_dir / name


def angle_has_cached_output(angle_dir: Path) -> bool:
    if not angle_dir.is_dir():
        return False
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        if any(angle_dir.glob(f"*{ext}")):
            return True
    return False


def save_generation_to_library(
    service_dir: str,
    *,
    source_path: str | Path,
    angle_id: int,
    comfy_output_file: str | Path,
    library_key: str | None = None,
) -> Path | None:
    lib_dir = image_library_dir(service_dir, source_path=source_path, library_key=library_key)
    ensure_starting_image(lib_dir, source_path)
    angle_dir = angle_subdir(lib_dir, angle_id)
    out = next_angle_output_path(angle_dir, suffix=Path(comfy_output_file).suffix or ".png")
    shutil.copy2(comfy_output_file, out)
    return out
