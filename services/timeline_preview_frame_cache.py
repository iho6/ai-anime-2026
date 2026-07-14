"""Process-wide LRU cache of composited preview PNG bytes.

Repeated scrubs and replays of the same range would otherwise re-decode (PyAV)
and re-encode (PNG) the identical frame every request. This caches the final
PNG bytes keyed by ``(timeline_key, clip_id, quantized_source_time, coloring)``
so a warm frame is served without touching the decoder.

Coloring is part of the key, so changing a clip's coloring simply produces cache
misses for the new signature (old entries age out via LRU); only media changes
require explicit invalidation, which mirrors the decoder cache.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from typing import Any

from services.clip_coloring import normalize_clip_coloring

_DEFAULT_MAX_ENTRIES = 512


def _coloring_signature(coloring: dict[str, Any] | None) -> str:
    return json.dumps(normalize_clip_coloring(coloring), sort_keys=True)


class TimelinePreviewFrameCache:
    def __init__(self, *, max_entries: int = _DEFAULT_MAX_ENTRIES) -> None:
        self._max_entries = max(1, int(max_entries))
        self._entries: "OrderedDict[tuple, bytes]" = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def _key(
        timeline_key: str,
        clip_id: str,
        source_time: float,
        coloring: dict[str, Any] | None,
    ) -> tuple:
        # Quantize to milliseconds so near-identical scrub times share a frame.
        return (
            str(timeline_key),
            str(clip_id),
            int(round(float(source_time) * 1000)),
            _coloring_signature(coloring),
        )

    def get(
        self,
        timeline_key: str,
        clip_id: str,
        source_time: float,
        coloring: dict[str, Any] | None,
    ) -> bytes | None:
        key = self._key(timeline_key, clip_id, source_time, coloring)
        with self._lock:
            data = self._entries.get(key)
            if data is not None:
                self._entries.move_to_end(key)
            return data

    def put(
        self,
        timeline_key: str,
        clip_id: str,
        source_time: float,
        coloring: dict[str, Any] | None,
        data: bytes,
    ) -> None:
        key = self._key(timeline_key, clip_id, source_time, coloring)
        with self._lock:
            self._entries[key] = data
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def invalidate_clip(self, timeline_key: str, clip_id: str) -> None:
        want = (str(timeline_key), str(clip_id))
        with self._lock:
            doomed = [k for k in self._entries if (k[0], k[1]) == want]
            for k in doomed:
                self._entries.pop(k, None)

    def invalidate_timeline(self, timeline_key: str) -> None:
        want = str(timeline_key)
        with self._lock:
            doomed = [k for k in self._entries if k[0] == want]
            for k in doomed:
                self._entries.pop(k, None)


# Process-wide singleton used by the timeline preview API.
preview_frame_cache = TimelinePreviewFrameCache()
