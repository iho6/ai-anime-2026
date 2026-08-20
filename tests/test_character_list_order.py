"""Newest-first character hub listing by durable createdAt."""

from __future__ import annotations

import json
import time
from pathlib import Path

from services import character_storage, logic


def test_list_characters_newest_first(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(character_storage, "DEFAULT_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(logic, "DEFAULT_STORAGE_ROOT", tmp_path)

    t0 = time.time() - 60
    for name, created in (
        ("zzzz_old", t0),
        ("aaaa_mid", t0 + 20),
        ("mmmm_new", t0 + 40),
    ):
        d = tmp_path / name
        d.mkdir()
        (d / "base_img.png").write_bytes(b"x")
        character_storage.write_character_created_at(d, created)

    # Draft / archive folders must be skipped by hub list.
    (tmp_path / "temp").mkdir()
    (tmp_path / "character_archive").mkdir()

    assert logic._character_list(tmp_path) == ["mmmm_new", "aaaa_mid", "zzzz_old"]
    assert character_storage.list_characters(
        tmp_path, skip={"temp", "character_archive"}
    ) == ["mmmm_new", "aaaa_mid", "zzzz_old"]


def test_list_characters_stable_after_cover_write(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(character_storage, "DEFAULT_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(logic, "DEFAULT_STORAGE_ROOT", tmp_path)

    t0 = time.time() - 30
    older = tmp_path / "older"
    newer = tmp_path / "newer"
    older.mkdir()
    newer.mkdir()
    character_storage.write_character_created_at(older, t0)
    character_storage.write_character_created_at(newer, t0 + 10)
    (older / "base_img.png").write_bytes(b"old")
    (newer / "base_img.png").write_bytes(b"new")

    assert logic._character_list(tmp_path) == ["newer", "older"]

    # Later gallery writes must not reshuffle.
    time.sleep(0.02)
    (older / "poses").mkdir()
    (older / "poses" / "pose1.png").write_bytes(b"pose")

    assert logic._character_list(tmp_path) == ["newer", "older"]
    meta = json.loads((older / "meta.json").read_text(encoding="utf-8"))
    assert meta["createdAt"] == t0
