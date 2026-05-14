"""Download and transcode video inputs for VL pipelines (extensionless URLs, odd containers)."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import requests

VIDEO_SUFFIXES: tuple[str, ...] = (
    ".mp4",
    ".mov",
    ".mkv",
    ".avi",
    ".webm",
    ".m4v",
)


def _path_suffix_for_ref(ref: str) -> str:
    s = ref.strip()
    if s.lower().startswith(("http://", "https://")):
        path = urlparse(s).path
        return Path(path).suffix.lower()
    return Path(s).suffix.lower()


def needs_normalization(ref: str) -> bool:
    """True if ref has no recognized video extension (path or URL path, ignoring query string)."""
    suf = _path_suffix_for_ref(ref)
    return suf not in VIDEO_SUFFIXES


def require_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError(
            "ffmpeg is required for video normalization but was not found on PATH. "
            "Install ffmpeg (e.g. apt install ffmpeg) and retry."
        )
    return exe


def transcode_to_mp4(src: Path, dst: Path) -> None:
    """Re-encode *src* to H.264/AAC MP4 at *dst* using ffmpeg."""
    ffmpeg = require_ffmpeg()
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(src),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(dst),
    ]
    try:
        subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        err = (exc.stderr or exc.stdout or "").strip()
        tail = err[-2000:] if err else "(no stderr)"
        raise RuntimeError(f"ffmpeg failed to transcode {src} -> {dst}: {tail}") from exc


def _download_url_to_file(url: str, dest: Path, timeout: float = 120.0) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)


def _local_cache_key(resolved: Path) -> str:
    st = resolved.stat()
    payload = f"{resolved}:{st.st_mtime_ns}:{st.st_size}".encode()
    return hashlib.sha256(payload).hexdigest()[:16]


def prepare_video_for_vl(ref: str, *, cache_dir: Path) -> str:
    """
    Return a path or URL suitable for Qwen-VL / vLLM: supported URL unchanged, otherwise
    absolute path to a cached .mp4 (after download + transcode when needed).
    """
    s = ref.strip()
    if not s:
        raise ValueError("video ref must be non-empty")

    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    if s.lower().startswith(("http://", "https://")):
        if not needs_normalization(s):
            return s
        url_key = hashlib.sha256(s.encode()).hexdigest()[:16]
        out = cache_dir / f"url_{url_key}.mp4"
        if out.is_file():
            return str(out.resolve())
        require_ffmpeg()
        tmp = cache_dir / f".tmp_url_{url_key}_download"
        try:
            _download_url_to_file(s, tmp)
            transcode_to_mp4(tmp, out)
        finally:
            tmp.unlink(missing_ok=True)
        return str(out.resolve())

    path = Path(s).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"Video file not found: {path}")
    resolved = path.resolve()
    if not needs_normalization(s):
        return str(resolved)
    out = cache_dir / f"local_{_local_cache_key(resolved)}.mp4"
    if out.is_file():
        return str(out.resolve())
    require_ffmpeg()
    transcode_to_mp4(resolved, out)
    return str(out.resolve())
