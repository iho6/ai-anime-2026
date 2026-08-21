"""Tests for KiMoD text encoder worker helpers."""

from __future__ import annotations

import os
import unittest
from unittest import mock

from services.motion_ref_gen_ai_service import text_encoder_worker as tew


class TextEncoderWorkerTests(unittest.TestCase):
    def test_text_encoder_url_default_port(self) -> None:
        self.assertEqual(tew.text_encoder_url(9550), "http://127.0.0.1:9550/")

    def test_text_encoder_port_env(self) -> None:
        with mock.patch.dict(os.environ, {"KIMODO_TEXT_ENCODER_PORT": "9666"}):
            self.assertEqual(tew.text_encoder_port(), 9666)

    def test_text_encoder_ready_timeout_default(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("KIMODO_TEXT_ENCODER_READY_TIMEOUT", None)
            self.assertEqual(tew.text_encoder_ready_timeout(), 600.0)

    def test_motion_worker_ready_timeout_env(self) -> None:
        with mock.patch.dict(os.environ, {"KIMODO_MOTION_WORKER_READY_TIMEOUT": "120"}):
            self.assertEqual(tew.motion_worker_ready_timeout(), 120.0)

    def test_motion_worker_child_env_forces_api_mode(self) -> None:
        env = tew.motion_worker_child_env(9550)
        self.assertEqual(env["TEXT_ENCODER_MODE"], "api")
        self.assertEqual(env["TEXT_ENCODER_URL"], "http://127.0.0.1:9550/")

    def test_text_encoder_child_env_sets_gradio_bind(self) -> None:
        env = tew.text_encoder_child_env(9550)
        self.assertEqual(env["GRADIO_SERVER_PORT"], "9550")
        self.assertEqual(env["GRADIO_SERVER_NAME"], "127.0.0.1")
        self.assertIn("TEXT_ENCODER_DEVICE", env)
        self.assertTrue(
            env["PYTHONPATH"].replace("\\", "/").split(";")[0].rstrip("/").endswith("/kimodo"),
            env["PYTHONPATH"],
        )

    def test_text_encoder_child_env_injects_hf_token_from_settings(self) -> None:
        with mock.patch.object(tew, "resolve_hf_token", return_value="hf_test_token"):
            env = tew.text_encoder_child_env(9550)
        self.assertEqual(env["HF_TOKEN"], "hf_test_token")
        self.assertEqual(env["HUGGINGFACE_HUB_TOKEN"], "hf_test_token")
        self.assertEqual(env["HUGGING_FACE_HUB_TOKEN"], "hf_test_token")
        self.assertTrue(env.get("KIMODO_HF_TOKEN_FILE"))

    def test_motion_worker_child_env_sets_pythonpath(self) -> None:
        env = tew.motion_worker_child_env(9550)
        self.assertTrue(
            env["PYTHONPATH"].replace("\\", "/").split(";")[0].rstrip("/").endswith("/kimodo"),
            env["PYTHONPATH"],
        )

    @mock.patch.object(tew, "validate_hf_token")
    @mock.patch.object(tew, "resolve_hf_token", return_value="hf_test_token")
    @mock.patch.object(tew, "_text_encoder_is_up", return_value=False)
    @mock.patch("services.kimodo_setup._ensure_kimodo_repo")
    @mock.patch("services.kimodo_setup.apply_kimodo_patches")
    @mock.patch.object(tew, "subprocess")
    def test_ensure_text_encoder_applies_patches_before_spawn(
        self,
        sp: mock.MagicMock,
        apply_patches: mock.MagicMock,
        ensure_repo: mock.MagicMock,
        _is_up: mock.MagicMock,
        _hf: mock.MagicMock,
        _validate: mock.MagicMock,
    ) -> None:
        proc = mock.MagicMock()
        proc.poll.return_value = None
        proc.stdout = iter(["READY:9550\n"])
        proc.stderr = iter([])
        sp.Popen.return_value = proc
        with mock.patch.object(tew, "_wait_for_text_encoder"):
            tew.ensure_text_encoder()
        ensure_repo.assert_called_once()
        apply_patches.assert_called_once()
        sp.Popen.assert_called_once()
        child_env = sp.Popen.call_args.kwargs["env"]
        self.assertEqual(child_env["HF_TOKEN"], "hf_test_token")

    @mock.patch.object(tew, "resolve_hf_token", return_value="")
    @mock.patch.object(tew, "_text_encoder_is_up", return_value=False)
    def test_ensure_text_encoder_requires_hf_token(
        self,
        _is_up: mock.MagicMock,
        _hf: mock.MagicMock,
    ) -> None:
        prev = tew._text_encoder_proc
        tew._text_encoder_proc = None
        try:
            with self.assertRaises(RuntimeError) as ctx:
                tew.ensure_text_encoder()
            self.assertIn("HF_TOKEN is missing", str(ctx.exception))
        finally:
            tew._text_encoder_proc = prev

    @mock.patch.object(tew, "_text_encoder_is_up", return_value=True)
    def test_ensure_text_encoder_skips_spawn_when_up(self, _is_up: mock.MagicMock) -> None:
        with mock.patch.object(tew, "subprocess") as sp:
            url = tew.ensure_text_encoder()
        self.assertEqual(url, "http://127.0.0.1:9550/")
        sp.Popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
