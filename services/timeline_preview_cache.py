"""Reusable _VideoFrameDecoder cache for timeline preview RGBA frame requests.

Export already reuses decoders via ``_CompositorState``; preview previously opened
a fresh decoder per HTTP request, which made alpha playback unusably slow.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from services.clip_coloring import apply_clip_coloring_rgba
from services.timeline_export import _VideoFrameDecoder

# Idle TTL before a cached decoder is closed and dropped.
_DEFAULT_TTL_SEC = 45.0
# Soft cap on concurrent cached decoders (LRU eviction beyond this).
_DEFAULT_MAX_ENTRIES = 8


@dataclass
class _CacheEntry:
    decoder: _VideoFrameDecoder
    video_path: Path
    last_access: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)
    revoked: bool = False


class TimelinePreviewDecoderCache:
    """Thread-safe LRU + TTL cache of video frame decoders keyed by timeline/clip."""

    def __init__(
        self,
        *,
        ttl_sec: float = _DEFAULT_TTL_SEC,
        max_entries: int = _DEFAULT_MAX_ENTRIES,
    ) -> None:
        self._ttl_sec = float(ttl_sec)
        self._max_entries = max(1, int(max_entries))
        self._entries: dict[tuple[str, str], _CacheEntry] = {}
        self._global = threading.Lock()

    def _key(self, timeline_key: str, clip_id: str) -> tuple[str, str]:
        return (str(timeline_key), str(clip_id))

    @staticmethod
    def _retire(entry: _CacheEntry) -> None:
        """Mark an entry revoked and close its decoder.

        ``_VideoFrameDecoder.close()`` is safe to call while another thread is
        mid-decode: it drops the iterators and swallows errors, and the decode
        path recovers by reopening. Marking ``revoked`` lets an in-flight
        ``get_rgba_frame`` (which grabbed this entry before we popped it) rebuild
        the decoder before touching it.
        """
        entry.revoked = True
        try:
            entry.decoder.close()
        except Exception:
            pass

    def invalidate_timeline(self, timeline_key: str) -> None:
        """Close and drop all decoders for a timeline (e.g. after media change)."""
        want = str(timeline_key)
        with self._global:
            doomed = [k for k in self._entries if k[0] == want]
            for k in doomed:
                entry = self._entries.pop(k, None)
                if entry is not None:
                    self._retire(entry)

    def invalidate_clip(self, timeline_key: str, clip_id: str) -> None:
        """Close and drop the decoder for a single clip (media changed)."""
        key = self._key(timeline_key, clip_id)
        with self._global:
            entry = self._entries.pop(key, None)
            if entry is not None:
                self._retire(entry)

    def invalidate_all(self) -> None:
        with self._global:
            for entry in self._entries.values():
                self._retire(entry)
            self._entries.clear()

    def _evict_expired_unlocked(self, now: float) -> None:
        expired = [
            k
            for k, e in self._entries.items()
            if (now - e.last_access) > self._ttl_sec
        ]
        for k in expired:
            entry = self._entries.pop(k, None)
            if entry is not None:
                self._retire(entry)

    def _evict_lru_unlocked(self) -> None:
        while len(self._entries) >= self._max_entries:
            oldest_key = min(self._entries.items(), key=lambda kv: kv[1].last_access)[0]
            entry = self._entries.pop(oldest_key, None)
            if entry is not None:
                self._retire(entry)

    def get_rgba_frame(
        self,
        timeline_key: str,
        clip: dict[str, Any],
        video_path: Path,
        source_time: float,
    ) -> Any:
        """Return a colored RGBA PIL image for ``source_time``, reusing a decoder when possible."""
        clip_id = str(clip.get("id") or "").strip()
        if not clip_id:
            raise ValueError("Clip id is required for preview cache.")

        key = self._key(timeline_key, clip_id)
        path = Path(video_path).resolve()
        now = time.monotonic()

        with self._global:
            self._evict_expired_unlocked(now)
            entry = self._entries.get(key)
            if entry is not None and entry.video_path != path:
                self._retire(entry)
                del self._entries[key]
                entry = None
            if entry is None:
                self._evict_lru_unlocked()
                decoder = _VideoFrameDecoder(path, clip, log_cb=None)
                entry = _CacheEntry(decoder=decoder, video_path=path, last_access=now)
                self._entries[key] = entry
            else:
                entry.last_access = now

        with entry.lock:
            # If another thread revoked/closed this decoder between us releasing
            # the global lock and acquiring the entry lock, rebuild before use.
            if entry.revoked:
                entry.decoder = _VideoFrameDecoder(path, clip, log_cb=None)
                entry.revoked = False
            rgba = entry.decoder.frame_at_source_time(float(source_time))
            return apply_clip_coloring_rgba(rgba, clip.get("coloring"))


# Process-wide singleton used by the timeline preview API.
preview_decoder_cache = TimelinePreviewDecoderCache()
