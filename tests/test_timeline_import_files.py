import asyncio
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

from ui.api import timeline_router


def _upload(name: str, data: bytes, content_type: str) -> UploadFile:
    return UploadFile(
        filename=name,
        file=BytesIO(data),
        headers=Headers({"content-type": content_type}),
    )


def _configure_import(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    timeline_dir = tmp_path / "timeline"
    clips_dir = timeline_dir / "clips"
    clips_dir.mkdir(parents=True)
    monkeypatch.setattr(timeline_router, "_timeline_dir", lambda _key: timeline_dir)
    monkeypatch.setattr(
        timeline_router.timeline_storage, "timeline_clips_dir", lambda _key: clips_dir
    )
    monkeypatch.setattr(
        timeline_router, "storage_rel_from_abs", lambda value: f"clips/{Path(value).name}"
    )
    return clips_dir


def test_import_files_preserves_order_and_metadata(monkeypatch, tmp_path):
    clips_dir = _configure_import(monkeypatch, tmp_path)

    def import_image(source, dest):
        out = Path(dest) / "image.png"
        out.write_bytes(Path(source).read_bytes())
        return {"absPath": str(out), "width": 20, "height": 10}

    def import_video(source, dest):
        out = Path(dest) / "video.mp4"
        out.write_bytes(Path(source).read_bytes())
        return {
            "absPath": str(out),
            "durationSec": 3.5,
            "width": 1920,
            "height": 1080,
            "fps": 24,
        }

    def import_audio(source, dest):
        out = Path(dest) / "audio.wav"
        out.write_bytes(Path(source).read_bytes())
        return {"absPath": str(out), "durationSec": 2.25}

    monkeypatch.setattr(timeline_router.logic, "import_image_to_timeline_clip", import_image)
    monkeypatch.setattr(timeline_router.logic, "import_video_to_timeline_clip", import_video)
    monkeypatch.setattr(timeline_router.logic, "import_audio_to_timeline_clip", import_audio)

    result = asyncio.run(
        timeline_router.timeline_import_files(
            "demo",
            [
                _upload("../../still.png", b"image", "image/png"),
                _upload("movie.mp4", b"video", "video/mp4"),
                _upload("sound.wav", b"audio", "audio/wav"),
            ],
        )
    )
    assert [item["type"] for item in result["items"]] == ["image", "video", "audio"]
    assert result["items"][0]["originalName"] == "still.png"
    assert result["items"][1]["durationSec"] == 3.5
    assert result["items"][1]["fps"] == 24
    assert result["items"][2]["durationSec"] == 2.25
    assert len(list(clips_dir.iterdir())) == 3


def test_import_files_rejects_unsupported_and_empty(monkeypatch, tmp_path):
    _configure_import(monkeypatch, tmp_path)
    with pytest.raises(HTTPException, match="Unsupported media type"):
        asyncio.run(
            timeline_router.timeline_import_files(
                "demo", [_upload("notes.txt", b"text", "text/plain")]
            )
        )
    with pytest.raises(HTTPException, match="is empty"):
        asyncio.run(
            timeline_router.timeline_import_files(
                "demo", [_upload("empty.png", b"", "image/png")]
            )
        )


def test_import_files_cleans_completed_outputs_after_partial_failure(monkeypatch, tmp_path):
    clips_dir = _configure_import(monkeypatch, tmp_path)

    def import_image(source, dest):
        out = Path(dest) / "first.png"
        out.write_bytes(Path(source).read_bytes())
        return {"absPath": str(out), "width": 1, "height": 1}

    monkeypatch.setattr(timeline_router.logic, "import_image_to_timeline_clip", import_image)
    monkeypatch.setattr(
        timeline_router.logic,
        "import_audio_to_timeline_clip",
        lambda _source, _dest: (_ for _ in ()).throw(ValueError("corrupt audio")),
    )
    with pytest.raises(HTTPException, match="corrupt audio"):
        asyncio.run(
            timeline_router.timeline_import_files(
                "demo",
                [
                    _upload("first.png", b"image", "image/png"),
                    _upload("bad.mp3", b"bad", "audio/mpeg"),
                ],
            )
        )
    assert list(clips_dir.iterdir()) == []
