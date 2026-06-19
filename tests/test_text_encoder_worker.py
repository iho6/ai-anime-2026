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
        self.assertIn("/kimodo", env["PYTHONPATH"])

    def test_motion_worker_child_env_sets_pythonpath(self) -> None:
        env = tew.motion_worker_child_env(9550)
        self.assertIn("/kimodo", env["PYTHONPATH"])

    @mock.patch.object(tew, "_text_encoder_is_up", return_value=True)
    def test_ensure_text_encoder_skips_spawn_when_up(self, _is_up: mock.MagicMock) -> None:
        with mock.patch.object(tew, "subprocess") as sp:
            url = tew.ensure_text_encoder()
        self.assertEqual(url, "http://127.0.0.1:9550/")
        sp.Popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
