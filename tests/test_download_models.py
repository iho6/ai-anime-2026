"""Regression tests for utils/download_models.py (no network downloads)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from utils.download_models import _unique_part_path, download_file


class _FakeResponse:
    def __init__(self, payload: bytes):
        self.headers = {"Content-Length": str(len(payload))}
        self._payload = payload

    def read(self, chunk_size: int = -1) -> bytes:
        if not self._payload:
            return b""
        if chunk_size <= 0:
            chunk_size = len(self._payload)
        chunk = self._payload[:chunk_size]
        self._payload = self._payload[chunk_size:]
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_unique_part_path_is_distinct_per_call(tmp_path: Path) -> None:
    dest = tmp_path / "model.safetensors"
    first = _unique_part_path(dest)
    second = _unique_part_path(dest)
    assert first != second
    assert first.name.startswith("model.safetensors.part.")
    assert second.name.startswith("model.safetensors.part.")
    assert first.parent == dest.parent


@patch("utils.download_models.urllib.request.urlopen")
@patch("utils.download_models.tqdm", side_effect=lambda *args, **kwargs: MagicMock())
def test_download_file_commits_non_empty_payload(
    _mock_tqdm: MagicMock,
    mock_urlopen: MagicMock,
    tmp_path: Path,
    capsys,
) -> None:
    dest = tmp_path / "weights" / "model.safetensors"
    payload = b"fake-model-bytes"
    mock_urlopen.return_value = _FakeResponse(payload)

    ok = download_file(
        "https://example.com/model.safetensors",
        str(dest),
        description="model.safetensors (test)",
    )

    assert ok is True
    assert dest.exists()
    assert dest.read_bytes() == payload
    leftover_parts = list(dest.parent.glob("model.safetensors.part.*"))
    assert leftover_parts == []
    out = capsys.readouterr().out
    assert "Successfully downloaded" in out


@patch("utils.download_models.urllib.request.urlopen")
@patch("utils.download_models.tqdm", side_effect=lambda *args, **kwargs: MagicMock())
def test_download_file_rejects_empty_payload(
    _mock_tqdm: MagicMock,
    mock_urlopen: MagicMock,
    tmp_path: Path,
    capsys,
) -> None:
    dest = tmp_path / "weights" / "empty.safetensors"
    mock_urlopen.return_value = _FakeResponse(b"")

    ok = download_file(
        "https://example.com/empty.safetensors",
        str(dest),
        description="empty.safetensors (test)",
    )

    assert ok is False
    assert not dest.exists()
    leftover_parts = list(dest.parent.glob("empty.safetensors.part.*"))
    assert leftover_parts == []
    out = capsys.readouterr().out
    assert "Download failed - empty file" in out


@patch("utils.download_models.urllib.request.urlopen")
@patch("utils.download_models.tqdm", side_effect=lambda *args, **kwargs: MagicMock())
def test_concurrent_invocations_use_isolated_temp_paths(
    _mock_tqdm: MagicMock,
    mock_urlopen: MagicMock,
    tmp_path: Path,
) -> None:
    dest_a = tmp_path / "shared" / "model_a.safetensors"
    dest_b = tmp_path / "shared" / "model_b.safetensors"
    seen_part_paths: list[Path] = []
    original_open = open

    def _track_open(path, mode="r", *args, **kwargs):
        file_obj = original_open(path, mode, *args, **kwargs)
        path_obj = Path(path)
        if mode == "wb" and ".part." in path_obj.name:
            seen_part_paths.append(path_obj)
        return file_obj

    def _fake_urlopen(_req, context=None):
        return _FakeResponse(b"payload")

    mock_urlopen.side_effect = _fake_urlopen

    with patch("builtins.open", side_effect=_track_open):
        assert download_file("https://example.com/a", str(dest_a), description="a") is True
        assert download_file("https://example.com/b", str(dest_b), description="b") is True

    assert len(seen_part_paths) == 2
    assert seen_part_paths[0] != seen_part_paths[1]
    assert dest_a.exists()
    assert dest_b.exists()
