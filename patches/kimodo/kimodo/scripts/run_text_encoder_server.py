# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import argparse
import os
import time

import gradio as gr
import numpy as np

from kimodo.model import resolve_target

from .gradio_theme import get_gradio_theme

os.environ["HF_ENABLE_PARALLEL_LOADING"] = "YES"
DEFAULT_TEXT = "A person walks and falls to the ground."
DEFAULT_SERVER_NAME = "0.0.0.0"
HEADLESS_SERVER_NAME = "127.0.0.1"
DEFAULT_SERVER_PORT = 9550
DEFAULT_TMP_FOLDER = "/tmp/text_encoder/"
DEFAULT_TEXT_ENCODER = "llm2vec"
TEXT_ENCODER_PRESETS = {
    "llm2vec": {
        "target": "kimodo.model.LLM2VecEncoder",
        "kwargs": {
            "base_model_name_or_path": "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp",
            "peft_model_name_or_path": "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised",
            "dtype": "bfloat16",
            "llm_dim": 4096,
            "device": "auto",
        },
        "display_name": "LLM2Vec",
    }
}


class DemoWrapper:
    def __init__(self, text_encoder, tmp_folder):
        self.text_encoder = text_encoder
        self.tmp_folder = tmp_folder

    def __call__(self, text, filename, progress=gr.Progress()):
        tensor, length = self.text_encoder(text)
        embedding = tensor[:length]
        embedding = embedding.cpu().numpy()

        path = os.path.join(self.tmp_folder, filename)
        np.save(path, embedding)

        output_title = gr.Markdown(visible=True)
        output_text = gr.Markdown(visible=True, value=f"Text: {text}")
        download = gr.DownloadButton(visible=True, value=path)
        return download, output_title, output_text


def _get_env(name: str, default):
    return os.getenv(name, default)


def _default_text_encoder_device() -> str:
    if os.getenv("TEXT_ENCODER_DEVICE"):
        return str(os.environ["TEXT_ENCODER_DEVICE"])
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


def _build_text_encoder(name: str, fp32: bool = False):
    if name not in TEXT_ENCODER_PRESETS:
        available = ", ".join(sorted(TEXT_ENCODER_PRESETS))
        raise ValueError(f"Unknown TEXT_ENCODER='{name}'. Available: {available}")
    preset = TEXT_ENCODER_PRESETS[name]
    target_cls = resolve_target(preset["target"])
    if fp32:
        preset["kwargs"]["dtype"] = "float32"
    return target_cls(**preset["kwargs"])


def parse_args(argv: list[str] | None = None):
    parser = argparse.ArgumentParser(description="Run text encoder Gradio server.")
    parser.add_argument(
        "--text-encoder",
        default=_get_env("TEXT_ENCODER", DEFAULT_TEXT_ENCODER),
        choices=sorted(TEXT_ENCODER_PRESETS.keys()),
        help="Text encoder preset.",
    )
    parser.add_argument(
        "--tmp-folder",
        default=_get_env("TEXT_ENCODER_TMP_FOLDER", DEFAULT_TMP_FOLDER),
    )
    parser.add_argument(
        "--fp32",
        action="store_true",
        help="Uses fp32 for the text encoder rather than default bfloat16.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run API-only Gradio server (no UI) for motion-ref text encoder worker.",
    )
    return parser.parse_args(argv)


def _build_demo(
    *,
    headless: bool,
    text_encoder,
    tmp_folder: str,
    display_name: str,
):
    theme, css = get_gradio_theme()
    demo_wrapper_fn = DemoWrapper(text_encoder, tmp_folder)

    with gr.Blocks(title="Text encoder", css=css, theme=theme) as demo:
        if not headless:
            gr.Markdown(f"# Text encoder: {display_name}")
            gr.Markdown("## Description")
            gr.Markdown("Get a embeddings from a text.")
            gr.Markdown("## Inputs")

        with gr.Row():
            text = gr.Textbox(
                placeholder="Type the motion you want to generate with a sentence",
                show_label=not headless,
                label="Text prompt",
                value=DEFAULT_TEXT,
                type="text",
                visible=not headless,
            )
        output_title = gr.Markdown("## Outputs", visible=False)
        output_text = gr.Markdown("", visible=False)
        with gr.Row(scale=3):
            with gr.Column(scale=1):
                download = gr.DownloadButton(
                    "Download", variant="primary", visible=False
                )
            with gr.Column(scale=4):
                pass

        filename = gr.Textbox(visible=False, value="embedding.npy")
        outputs = [download, output_title, output_text]

        encode_btn = gr.Button("Encode", visible=not headless, variant="primary")
        encode_btn.click(
            fn=demo_wrapper_fn,
            inputs=[text, filename],
            outputs=outputs,
            api_name="DemoWrapper",
        )

        if not headless:
            clear = gr.Button("Clear", variant="secondary")

            def clear_fn():
                return [
                    gr.DownloadButton(visible=False),
                    gr.Markdown(visible=False),
                    gr.Markdown(visible=False),
                ]

            gr.on(
                triggers=[text.submit, encode_btn.click],
                fn=clear_fn,
                inputs=None,
                outputs=outputs,
            ).then(
                fn=demo_wrapper_fn,
                inputs=[text, filename],
                outputs=outputs,
            )

            def download_file():
                return gr.DownloadButton()

            download.click(fn=download_file, inputs=None, outputs=[download])
            clear.click(fn=clear_fn, inputs=None, outputs=outputs)

    return demo


def main():
    args = parse_args()
    headless = bool(args.headless)
    if headless:
        os.environ.setdefault("TEXT_ENCODER_DEVICE", _default_text_encoder_device())
        server_name = _get_env("GRADIO_SERVER_NAME", HEADLESS_SERVER_NAME)
    else:
        server_name = _get_env("GRADIO_SERVER_NAME", DEFAULT_SERVER_NAME)
    server_port = int(_get_env("GRADIO_SERVER_PORT", DEFAULT_SERVER_PORT))
    os.makedirs(args.tmp_folder, exist_ok=True)
    text_encoder = _build_text_encoder(args.text_encoder, args.fp32)
    display_name = TEXT_ENCODER_PRESETS[args.text_encoder]["display_name"]
    demo = _build_demo(
        headless=headless,
        text_encoder=text_encoder,
        tmp_folder=args.tmp_folder,
        display_name=display_name,
    )

    if headless:
        demo.launch(
            server_name=server_name,
            server_port=server_port,
            prevent_thread_lock=True,
            quiet=True,
        )
        print(f"READY:{server_port}", flush=True)
        while True:
            time.sleep(3600)
    else:
        demo.launch(server_name=server_name, server_port=server_port)


if __name__ == "__main__":
    main()
