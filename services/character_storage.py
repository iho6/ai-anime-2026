"""
Character-based local storage helpers for anime2026 services.

UI-owned: serverless stays structure-agnostic and returns public `url`s.
The UI downloads those URLs and writes files under a deterministic character folder layout.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import requests

CHARACTER_META_FILENAME = "meta.json"


_SERVICES_DIR = Path(__file__).resolve().parent


def _resolved_default_storage_root() -> Path:
    """
    Root directory containing one folder per character key.

    Set ANIME_STORAGE_ROOT to an absolute path to store data outside the repo.
    """
    raw = (os.environ.get("ANIME_STORAGE_ROOT") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (_SERVICES_DIR.parent / "storage" / "characters").resolve()


DEFAULT_STORAGE_ROOT = _resolved_default_storage_root()


def sanitize_for_folder(name: str, *, max_len: int = 80) -> str:
    """
    Convert arbitrary user names/labels into safe folder names.
    Keeps ASCII (Cursor edits prefer ASCII) and collapses whitespace.
    """

    n = (name or "").strip()
    if not n:
        return "unnamed"

    # Replace anything except alnum/underscore/hyphen with underscore.
    n = re.sub(r"[^A-Za-z0-9_\-]+", "_", n)
    n = re.sub(r"_+", "_", n).strip("_")
    if not n:
        n = "unnamed"

    return n[:max_len]


def unique_suffix(nbytes: int = 8) -> str:
    # Keep it filename friendly; 8 hex chars is usually enough.
    return uuid.uuid4().hex[:nbytes]


@dataclass(frozen=True)
class CharacterPaths:
    storage_root: Path
    character_key: str

    @property
    def character_dir(self) -> Path:
        return self.storage_root / self.character_key

    @property
    def base_dir(self) -> Path:
        return self.character_dir

    @property
    def poses_dir(self) -> Path:
        return self.character_dir / "poses"

    @property
    def expressions_dir(self) -> Path:
        return self.character_dir / "expressions"

    @property
    def datasets_dir(self) -> Path:
        """Exported training datasets: ``<character>/dataset/<dataset_name>/``."""
        return self.character_dir / "dataset"

    @property
    def sequences_dir(self) -> Path:
        """Animation sequences: ``<character>/sequence/<sequence_name>/``."""
        return self.character_dir / "sequence"

    def dataset_dir(self, dataset_name: str) -> Path:
        return self.datasets_dir / sanitize_for_folder(dataset_name)

    def sequence_dir(self, sequence_name: str) -> Path:
        return self.sequences_dir / sanitize_for_folder(sequence_name)

    def pose_dir(self, pose_label: str) -> Path:
        return self.poses_dir / sanitize_for_folder(pose_label)

    def expression_dir(self, expression_label: str) -> Path:
        return self.expressions_dir / sanitize_for_folder(expression_label)


def get_character_paths(character_key: str, *, storage_root: Path | None = None):
    root = storage_root or DEFAULT_STORAGE_ROOT
    ck = sanitize_for_folder(character_key)
    return CharacterPaths(storage_root=root, character_key=ck)


def ensure_dirs(*paths: Path) -> None:
    for p in paths:
        p.mkdir(parents=True, exist_ok=True)


def infer_ext_from_url(url: str) -> str:
    # We only need a best-effort extension for filenames.
    u = url.split("?", 1)[0].split("#", 1)[0]
    tail = u.split("/")[-1]
    lower = tail.lower()
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"):
        if lower.endswith(ext):
            return ext
    return ".png"


def download_url_to_file(url: str, dest_path: Path, *, timeout_s: int = 120) -> Path:
    """
    Download an image URL to a local file path, or copy if url is a local path.
    Returns the written file path.
    """
    import shutil as _shutil
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    src = Path(url)
    if src.is_file():
        _shutil.copy2(src, dest_path)
        return dest_path
    with requests.get(url, stream=True, timeout=timeout_s) as r:
        r.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=128 * 1024):
                if chunk:
                    f.write(chunk)
    return dest_path


def write_base_image_from_url(
    character: CharacterPaths, url: str, *, ext: str | None = None
) -> Path:
    ext_final = ext or infer_ext_from_url(url)
    dest = character.base_dir / f"base{ext_final}"
    download_url_to_file(url, dest)
    return dest


def write_starting_image_from_url(
    pose_or_expression_dir: Path, url: str, *, filename_stem: str, ext: str | None = None
) -> Path:
    ext_final = ext or infer_ext_from_url(url)
    dest = pose_or_expression_dir / f"starting_image{ext_final}"
    download_url_to_file(url, dest)
    return dest


def write_angle_000_from_url(
    pose_or_expression_dir: Path, url: str, *, ext: str | None = None
) -> Path:
    ext_final = ext or infer_ext_from_url(url)
    dest = pose_or_expression_dir / f"angle_000{ext_final}"
    download_url_to_file(url, dest)
    return dest


def write_multi_angle_flat_from_url(
    pose_or_expression_dir: Path,
    angle_id: int,
    url: str,
    *,
    ext: str | None = None,
) -> Path:
    ext_final = ext or infer_ext_from_url(url)
    filename = f"angle_{int(angle_id):03d}_{unique_suffix()}{ext_final}"
    dest = pose_or_expression_dir / filename
    download_url_to_file(url, dest)
    return dest


def write_multi_angle_appended_stem(
    pose_or_expression_dir: Path,
    parent_file: Path,
    camera_angle_id: int,
    url: str,
    *,
    ext: str | None = None,
) -> Path:
    """
    Write a multi-angle result as ``{parent_stem}_angle_{MMM}.{ext}`` next to siblings
    under ``pose_or_expression_dir`` (flat gallery root).
    """
    ext_final = ext or infer_ext_from_url(url)
    stem = parent_file.stem
    dest = pose_or_expression_dir / f"{stem}_angle_{int(camera_angle_id):03d}{ext_final}"
    download_url_to_file(url, dest)
    return dest


def path_created_at(path: Path) -> float:
    """Best-effort filesystem creation time (seconds since epoch).

    Prefers ``st_birthtime`` when present; on Windows ``st_ctime`` is creation
    time. Elsewhere falls back to ``st_mtime`` (less ideal but stable enough as
    a one-time seed for ``createdAt`` metadata).
    """
    st = path.stat()
    birth = getattr(st, "st_birthtime", None)
    if birth is not None:
        return float(birth)
    if os.name == "nt":
        return float(st.st_ctime)
    return float(st.st_mtime)


def character_meta_path(character_dir: Path) -> Path:
    return character_dir / CHARACTER_META_FILENAME


def read_character_created_at(character_dir: Path) -> float | None:
    meta = character_meta_path(character_dir)
    if not meta.is_file():
        return None
    try:
        data = json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    raw = data.get("createdAt")
    if isinstance(raw, (int, float)):
        return float(raw)
    return None


def write_character_created_at(character_dir: Path, created_at: float | None = None) -> float:
    """Write/merge ``meta.json`` ``createdAt``; return the stamped value."""
    character_dir.mkdir(parents=True, exist_ok=True)
    stamp = float(created_at if created_at is not None else time.time())
    meta = character_meta_path(character_dir)
    data: dict = {}
    if meta.is_file():
        try:
            loaded = json.loads(meta.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, json.JSONDecodeError, TypeError):
            data = {}
    if isinstance(data.get("createdAt"), (int, float)):
        return float(data["createdAt"])
    data["createdAt"] = stamp
    tmp = meta.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(meta)
    return stamp


def ensure_character_created_at(character_dir: Path) -> float:
    """Return durable creation time, seeding ``meta.json`` from FS birth when missing."""
    existing = read_character_created_at(character_dir)
    if existing is not None:
        return existing
    try:
        seed = path_created_at(character_dir)
    except OSError:
        seed = time.time()
    try:
        return write_character_created_at(character_dir, seed)
    except OSError:
        return seed


def list_characters(
    storage_root: Path | None = None,
    *,
    skip: set[str] | frozenset[str] | None = None,
) -> list[str]:
    """Character folder names, newest-first by durable ``createdAt``."""
    root = storage_root or DEFAULT_STORAGE_ROOT
    if not root.exists():
        return []
    skip_names = skip or set()
    dirs = [
        p
        for p in root.iterdir()
        if p.is_dir() and p.name not in skip_names and not p.name.startswith(".")
    ]

    def sort_key(p: Path) -> tuple[float, str]:
        return (-ensure_character_created_at(p), p.name.lower())

    dirs.sort(key=sort_key)
    return [p.name for p in dirs]


def list_pose_labels(character: CharacterPaths) -> list[str]:
    if not character.poses_dir.exists():
        return []
    return sorted([p.name for p in character.poses_dir.iterdir() if p.is_dir()])


def list_expression_labels(character: CharacterPaths) -> list[str]:
    if not character.expressions_dir.exists():
        return []
    return sorted(
        [p.name for p in character.expressions_dir.iterdir() if p.is_dir()]
    )

