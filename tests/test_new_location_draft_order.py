"""Newest-first ordering for location creation draft workspace."""

from __future__ import annotations

import os
import time
from pathlib import Path

from services import logic


def test_list_new_location_draft_paths_newest_first(tmp_path: Path, monkeypatch) -> None:
    draft_root = tmp_path / "_drafts"
    draft_root.mkdir()
    monkeypatch.setattr(logic, "LOCATION_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(logic, "NEW_LOCATION_DRAFT_DIRNAME", "_drafts")

    older = draft_root / "draft_zzzzzzzzzzzz.png"
    middle = draft_root / "draft_aaaaaaaaaaaa.png"
    newest = draft_root / "draft_mmmmmmmmmmmm.png"
    older.write_bytes(b"old")
    middle.write_bytes(b"mid")
    newest.write_bytes(b"new")

    # Lexicographic order would be aaaa, mmmm, zzzz — mtime order must win.
    t0 = time.time() - 30
    os.utime(older, (t0, t0))
    os.utime(middle, (t0 + 10, t0 + 10))
    os.utime(newest, (t0 + 20, t0 + 20))

    paths = logic.list_new_location_draft_paths()
    names = [Path(p).name for p in paths]
    assert names == [
        "draft_mmmmmmmmmmmm.png",
        "draft_aaaaaaaaaaaa.png",
        "draft_zzzzzzzzzzzz.png",
    ]


def test_list_new_location_draft_paths_empty_dir(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(logic, "LOCATION_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(logic, "NEW_LOCATION_DRAFT_DIRNAME", "_drafts")
    assert logic.list_new_location_draft_paths() == []
