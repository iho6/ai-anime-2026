from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from services import logic
from services.t2v_ai_service import serverless
from ui.api import reference_router


def _workflow() -> dict[str, Any]:
    path = (
        Path(__file__).parents[1]
        / "services"
        / "t2v_ai_service"
        / "workflows"
        / "video_wan2_2_14B_t2v_lightning_api.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))


def test_wan_t2v_workflow_patch_is_native_and_updates_inputs() -> None:
    original = _workflow()
    patched = serverless._patch_workflow(
        original,
        prompt="a moving ink drawing",
        negative_prompt="text, watermark",
        width=768,
        height=432,
        length=49,
        fps=12,
        seed=123,
    )

    assert original["10"]["inputs"]["width"] == 640
    assert patched["10"]["inputs"] == {
        "width": 768,
        "height": 432,
        "length": 49,
        "batch_size": 1,
    }
    assert patched["8"]["inputs"]["text"] == "a moving ink drawing"
    assert patched["9"]["inputs"]["text"] == "text, watermark"
    assert patched["11"]["inputs"]["noise_seed"] == 123
    assert patched["15"]["inputs"]["fps"] == 12.0
    serialized = json.dumps(patched).lower()
    assert "qwen" not in serialized
    assert "wanimagetovideo" not in serialized
    assert all(
        node.get("class_type") != "LoadImage" for node in patched.values()
    )


def test_generate_reference_video_preview_stores_mp4_and_cleans_temp(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from PIL import Image

    source_frames: list[str] = []
    for index in range(49):
        path = tmp_path / f"source_{index:03d}.png"
        Image.new("RGB", (8, 8), (index, 0, 0)).save(path)
        source_frames.append(str(path))

    captured: dict[str, Any] = {}

    def fake_t2v(**kwargs: Any) -> list[str]:
        captured.update(kwargs)
        return source_frames

    monkeypatch.setattr(logic, "_run_t2v_service", fake_t2v)

    encoded_path: Path | None = None

    def fake_encode(frames: list[Path], out_path: Path, fps: int) -> None:
        nonlocal encoded_path
        assert len(frames) == 49
        assert fps == 16
        encoded_path = Path(out_path)
        encoded_path.write_bytes(b"fake-h264")

    def fake_add_preview(path: str) -> str:
        assert Path(path).read_bytes() == b"fake-h264"
        return "references/_preview/prev_video.mp4"

    monkeypatch.setattr(logic, "encode_frames_to_mp4", fake_encode)
    monkeypatch.setattr(
        "services.reference_storage.add_preview",
        fake_add_preview,
    )

    result = logic.generate_reference_video_preview(prompt_text="moving clouds")

    assert captured["length"] == 49
    assert captured["fps"] == 16
    assert result == {
        "kind": "video",
        "previewRelPath": "references/_preview/prev_video.mp4",
        "fps": 16,
        "durationSec": 49 / 16,
    }
    assert encoded_path is not None
    assert not encoded_path.exists()


def test_generate_reference_video_preview_normalizes_custom_length(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from PIL import Image

    length = 81
    source_frames: list[str] = []
    for index in range(length):
        path = tmp_path / f"src_{index:03d}.png"
        Image.new("RGB", (4, 4), (index % 255, 0, 0)).save(path)
        source_frames.append(str(path))

    captured: dict[str, Any] = {}

    def fake_t2v(**kwargs: Any) -> list[str]:
        captured.update(kwargs)
        return source_frames

    monkeypatch.setattr(logic, "_run_t2v_service", fake_t2v)
    monkeypatch.setattr(
        logic,
        "encode_frames_to_mp4",
        lambda frames, out_path, fps: Path(out_path).write_bytes(b"vid"),
    )
    monkeypatch.setattr(
        "services.reference_storage.add_preview",
        lambda _path: "references/_preview/custom.mp4",
    )

    # 80 snaps to nearest 4n+1 in [25, 121] → 81
    result = logic.generate_reference_video_preview(
        prompt_text="wind",
        length=80,
    )
    assert captured["length"] == 81
    assert result["durationSec"] == pytest.approx(81 / 16)


class _FakeWebSocket:
    def __init__(self, message: dict[str, Any]):
        self.message = message
        self.sent: list[dict[str, Any]] = []

    async def accept(self) -> None:
        return None

    async def receive_json(self) -> dict[str, Any]:
        return self.message

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def test_reference_router_dispatches_video_kind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def fake_video(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"kind": "video", "previewRelPath": "references/_preview/v.mp4"}

    async def fake_stream(_ws: Any, work: Any) -> tuple[dict[str, Any], None]:
        return work(None), None

    async def fake_send(ws: _FakeWebSocket, payload: dict[str, Any]) -> None:
        ws.sent.append(payload)

    monkeypatch.setattr(logic, "generate_reference_video_preview", fake_video)
    monkeypatch.setattr(reference_router, "run_with_log_stream", fake_stream)
    monkeypatch.setattr(reference_router, "safe_send_json", fake_send)
    ws = _FakeWebSocket(
        {
            "kind": "video",
            "promptText": "a crane takes flight",
            "negativePrompt": "watermark",
            "length": 65,
        }
    )

    asyncio.run(reference_router.reference_generate_ws(ws))  # type: ignore[arg-type]

    assert calls[0]["prompt_text"] == "a crane takes flight"
    assert calls[0]["negative_prompt"] == "watermark"
    assert calls[0]["length"] == 65
    assert ws.sent[-1]["ok"] is True
    assert ws.sent[-1]["result"]["kind"] == "video"


def test_reference_router_defaults_to_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_calls: list[dict[str, Any]] = []

    def fake_image(**kwargs: Any) -> dict[str, str]:
        image_calls.append(kwargs)
        return {"kind": "image", "previewRelPath": "references/_preview/i.png"}

    async def fake_stream(_ws: Any, work: Any) -> tuple[dict[str, Any], None]:
        return work(None), None

    async def fake_send(ws: _FakeWebSocket, payload: dict[str, Any]) -> None:
        ws.sent.append(payload)

    monkeypatch.setattr(logic, "generate_reference_preview", fake_image)
    monkeypatch.setattr(reference_router, "run_with_log_stream", fake_stream)
    monkeypatch.setattr(reference_router, "safe_send_json", fake_send)
    ws = _FakeWebSocket({"promptText": "portrait", "width": 512, "height": 768})

    asyncio.run(reference_router.reference_generate_ws(ws))  # type: ignore[arg-type]

    assert image_calls[0]["width"] == 512
    assert image_calls[0]["height"] == 768
    assert ws.sent[-1]["result"]["kind"] == "image"
