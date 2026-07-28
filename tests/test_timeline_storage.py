"""Tests for timeline manifest read/write helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from services import timeline_storage


@pytest.fixture()
def timelines_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "timelines"
    root.mkdir()
    monkeypatch.setattr(timeline_storage, "TIMELINES_STORAGE_ROOT", root)
    return root


def test_read_manifest_recovers_trailing_extra_brace(timelines_root: Path) -> None:
    key = "t1"
    d = timelines_root / key
    d.mkdir()
    (d / "manifest.json").write_text(
        '{\n  "version": 2,\n  "fps": 24,\n  "tracks": []\n}}\n',
        encoding="utf-8",
    )
    data = timeline_storage.read_manifest(key)
    assert data["version"] == 2
    assert data["tracks"] == []


def test_read_manifest_still_raises_on_garbage(timelines_root: Path) -> None:
    key = "bad"
    d = timelines_root / key
    d.mkdir()
    (d / "manifest.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(Exception):
        timeline_storage.read_manifest(key)
