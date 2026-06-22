"""Gallery-only sequence import resolution for timeline materialization."""

from __future__ import annotations

from services.logic import _first_exportable_gallery_frame_sequence_id


def test_returns_first_exportable_gallery_frame_sequence_id() -> None:
    manifest = {
        "version": 1,
        "fps": 24,
        "frames": [],
        "gallery": [
            {
                "id": "g1",
                "relPath": "cover.png",
                "frameSequence": {
                    "sequenceGroupId": "sg1",
                    "strip": [{"kind": "image", "relPath": "gallery/f0.png"}],
                    "hidden": [],
                },
            }
        ],
    }
    assert _first_exportable_gallery_frame_sequence_id(manifest) == "g1"


def test_skips_non_exportable_gallery_items() -> None:
    manifest = {
        "gallery": [
            {
                "id": "empty",
                "frameSequence": {
                    "strip": [{"kind": "empty"}],
                    "hidden": [],
                },
            },
            {
                "id": "hidden",
                "frameSequence": {
                    "strip": [{"kind": "image", "relPath": "x.png", "hidden": True}],
                    "hidden": [],
                },
            },
            {
                "id": "ok",
                "frameSequence": {
                    "strip": [{"kind": "image", "relPath": "y.png"}],
                    "hidden": [],
                },
            },
        ],
    }
    assert _first_exportable_gallery_frame_sequence_id(manifest) == "ok"


def test_returns_none_when_no_exportable_gallery_items() -> None:
    manifest = {
        "frames": [],
        "gallery": [{"id": "g1", "relPath": "still.png"}],
    }
    assert _first_exportable_gallery_frame_sequence_id(manifest) is None
