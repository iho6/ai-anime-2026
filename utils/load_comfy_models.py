#!/usr/bin/env python3
"""Download ComfyUI model weights for this repo's two local-Comfy services.

Targets workflows:
  - services/img_edit_service/image_qwen_image_edit_2509.json (img-edit)
  - services/edit_angle_service/qwen_image_edit_angle_single.json (edit-angle)

Run from the directory ComfyUI uses as its model root (often the vendored ``comfyui/``
folder or repo root if ``models/`` is shared). Paths are relative (e.g. ``models/loras/...``).

Usage:
    python utils/load_comfy_models.py --img-edit [--hf-token YOUR_TOKEN]
    python utils/load_comfy_models.py --edit-angle [--hf-token YOUR_TOKEN]
    python utils/load_comfy_models.py --img-edit --edit-angle
    python utils/load_comfy_models.py --image-edit   # alias for --img-edit
    python utils/load_comfy_models.py --img-edit --force-redownload
"""

from __future__ import annotations

import argparse
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from tqdm import tqdm


@dataclass(frozen=True)
class ModelSpec:
    name: str
    url: str
    path: str


@dataclass(frozen=True)
class DownloadOptions:
    hf_token: str | None = None
    force_redownload: bool = False
    skip_ssl_verify: bool = False


class ProgressRenderer:
    class _TqdmPipeLineStdout:
        """Turn tqdm CR refreshes into newline output for piped logs."""

        def __init__(self, raw: TextIO):
            self._raw = raw
            self.encoding = getattr(raw, "encoding", None)

        def write(self, s: str) -> int:
            if not s:
                return 0
            if "\r" in s:
                core = s.split("\r")[-1].rstrip()
                if core:
                    self._raw.write(core + "\n")
                return len(s)
            self._raw.write(s)
            return len(s)

        def flush(self) -> None:
            self._raw.flush()

    def __init__(self, stdout: TextIO | None = None):
        self.stdout = stdout or sys.stdout

    def stream(self):
        """Use single-line redraw in TTY; newline-safe output in piped logs."""
        if hasattr(self.stdout, "isatty") and self.stdout.isatty():
            return self.stdout
        return self._TqdmPipeLineStdout(self.stdout)


class FileCommitter:
    @staticmethod
    def _is_windows_sharing_violation(exc: BaseException) -> bool:
        if os.name != "nt":
            return False
        return isinstance(exc, OSError) and getattr(exc, "winerror", None) == 32

    def replace_with_retry(self, part: Path, dest: Path) -> None:
        """Commit ``.part`` to final path; retry on transient Windows file locks."""
        max_attempts = 25
        delay_s = 0.25
        for attempt in range(max_attempts):
            try:
                os.replace(part, dest)
                return
            except OSError as e:
                if not self._is_windows_sharing_violation(e):
                    raise
                if attempt >= max_attempts - 1:
                    print(
                        "    HINT: Another program may be locking files under models\\ "
                        "(e.g. Windows Defender, Explorer preview, or cloud sync). "
                        "Try again or add an exclusion; re-run this script to resume."
                    )
                    raise
                time.sleep(delay_s)
                delay_s = min(2.0, delay_s + 0.25)


class ModelCatalog:
    IMG_EDIT_MODELS = [
        ModelSpec(
            name="qwen_2.5_vl_7b_fp8_scaled.safetensors (Text Encoder)",
            url="https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
            path="models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        ),
        ModelSpec(
            name="Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors (LoRA)",
            url="https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
            path="models/loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
        ),
        ModelSpec(
            name="qwen_image_edit_2509_fp8_e4m3fn.safetensors (Diffusion Model)",
            url="https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
            path="models/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
        ),
        ModelSpec(
            name="qwen_image_vae.safetensors (VAE)",
            url="https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
            path="models/vae/qwen_image_vae.safetensors",
        ),
    ]
    MULTIPLE_ANGLES_LORA = ModelSpec(
        name="Qwen-Edit-2509-Multiple-angles.safetensors (Multi-angle LoRA)",
        url="https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/loras/Qwen-Edit-2509-Multiple-angles.safetensors",
        path="models/loras/Qwen-Edit-2509-Multiple-angles.safetensors",
    )

    def dedupe(self, models: list[ModelSpec]) -> list[ModelSpec]:
        """Deduplicate models by destination path (first definition wins)."""
        deduped: list[ModelSpec] = []
        seen_paths: set[str] = set()
        for model in models:
            path = model.path.strip()
            if not path or path in seen_paths:
                continue
            deduped.append(model)
            seen_paths.add(path)
        return deduped

    def service_model_map(self) -> dict[str, list[ModelSpec]]:
        edit_angle_models = self.dedupe(self.IMG_EDIT_MODELS + [self.MULTIPLE_ANGLES_LORA])
        return {
            "img_edit": list(self.IMG_EDIT_MODELS),
            "edit_angle": edit_angle_models,
        }

    def select(self, *, img_edit: bool, edit_angle: bool) -> list[ModelSpec]:
        selected_models: list[ModelSpec] = []
        model_map = self.service_model_map()
        if img_edit:
            selected_models.extend(model_map["img_edit"])
        if edit_angle:
            selected_models.extend(model_map["edit_angle"])
        return self.dedupe(selected_models)


class ModelDownloader:
    def __init__(
        self,
        progress: ProgressRenderer | None = None,
        committer: FileCommitter | None = None,
        models_root: Path | None = None,
    ):
        self.progress = progress or ProgressRenderer()
        self.committer = committer or FileCommitter()
        self.models_root = (models_root or (Path(__file__).resolve().parents[1] / "comfyui" / "models")).resolve()

    def resolve_destination(self, spec: ModelSpec) -> Path:
        spec_path = Path(spec.path)
        if spec_path.is_absolute():
            return spec_path
        parts = spec_path.parts
        if parts and parts[0] == "models":
            return self.models_root.joinpath(*parts[1:])
        return self.models_root / spec_path

    def download_one(self, spec: ModelSpec, options: DownloadOptions) -> bool:
        """Download a model to destination with optional HF authentication."""
        destination_path = self.resolve_destination(spec)
        destination_path.parent.mkdir(parents=True, exist_ok=True)

        part_path = destination_path.with_suffix(destination_path.suffix + ".part")
        if options.force_redownload:
            if part_path.exists():
                try:
                    part_path.unlink()
                except OSError as e:
                    print(f"  ERROR: Could not remove partial download {part_path}: {e}")
                    return False
            if destination_path.exists():
                try:
                    destination_path.unlink()
                    print(f"  --force-redownload: removed existing {destination_path.name}")
                except OSError as e:
                    print(f"  ERROR: Could not remove existing file {destination_path}: {e}")
                    return False

        if destination_path.exists():
            file_size = destination_path.stat().st_size
            print(
                f"  OK  {spec.name or destination_path.name} already exists "
                f"({file_size / (1024*1024):.1f} MB)"
            )
            return True

        print(f"  Downloading {spec.name or destination_path.name}...")
        print(f"    From: {spec.url}")
        print(f"    To: {destination_path}")

        try:
            ssl_context = None
            if options.skip_ssl_verify:
                ssl_context = ssl.create_default_context()
                ssl_context.check_hostname = False
                ssl_context.verify_mode = ssl.CERT_NONE
                print("    WARN: SSL verification disabled for this download")

            req = urllib.request.Request(spec.url)
            if options.hf_token and "huggingface.co" in spec.url:
                req.add_header("Authorization", f"Bearer {options.hf_token}")

            if part_path.exists():
                try:
                    part_path.unlink()
                except Exception:
                    pass

            with urllib.request.urlopen(req, context=ssl_context) as resp:
                total = resp.headers.get("Content-Length")
                total_bytes = int(total) if total and str(total).isdigit() else None
                chunk_size = 1024 * 1024
                desc = (spec.name or destination_path.name).strip()

                with tqdm(
                    total=total_bytes,
                    unit="B",
                    unit_scale=True,
                    unit_divisor=1024,
                    desc=desc,
                    dynamic_ncols=False,
                    disable=False,
                    file=self.progress.stream(),
                ) as bar:
                    with open(part_path, "wb") as f:
                        while True:
                            chunk = resp.read(chunk_size)
                            if not chunk:
                                break
                            f.write(chunk)
                            bar.update(len(chunk))
                        f.flush()
                        os.fsync(f.fileno())

            part_size = part_path.stat().st_size if part_path.exists() else 0
            if part_size <= 0:
                print("  ERROR: Download failed - empty file")
                try:
                    part_path.unlink()
                except Exception:
                    pass
                return False

            self.committer.replace_with_retry(part_path, destination_path)
            file_size = destination_path.stat().st_size
            print(f"  OK  Successfully downloaded ({file_size / (1024*1024):.1f} MB)")
            return True

        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                print(f"  ERROR: Authorization failed: {e}")
                print("    Get your token from: https://huggingface.co/settings/tokens")
                print(
                    "    Then run: python utils/load_comfy_models.py --img-edit --hf-token YOUR_TOKEN"
                )
            else:
                print(f"  ERROR: Download failed: {e}")
            return False
        except Exception as e:
            print(f"  ERROR: Download failed: {e}")
            try:
                part_path.unlink()
            except Exception:
                pass
            return False


class DownloadOrchestrator:
    def __init__(self, downloader: ModelDownloader | None = None):
        self.downloader = downloader or ModelDownloader()

    def download_group(self, title: str, models: list[ModelSpec], options: DownloadOptions) -> bool:
        print("=" * 60)
        print(title)
        print("=" * 60)
        models_root = getattr(self.downloader, "models_root", Path("models"))
        configs_dir = Path(models_root) / "configs"
        configs_dir.mkdir(parents=True, exist_ok=True)
        print(f"[OK] Created/verified {configs_dir} directory")

        success = 0
        for model in models:
            if self.downloader.download_one(model, options):
                success += 1

        print("\n" + "=" * 60)
        print(f"Download complete: {success}/{len(models)} models")
        print("=" * 60)
        return success == len(models)


class DownloadCLI:
    def __init__(self, catalog: ModelCatalog | None = None, orchestrator: DownloadOrchestrator | None = None):
        self.catalog = catalog or ModelCatalog()
        self.orchestrator = orchestrator or DownloadOrchestrator()

    @staticmethod
    def build_parser() -> argparse.ArgumentParser:
        parser = argparse.ArgumentParser(
            description=(
                "Download model weights for services/img_edit_service (img-edit) and "
                "services/edit_angle_service (edit-angle) Comfy workflows."
            ),
            epilog=(
                "Examples:\n"
                "  python utils/load_comfy_models.py --img-edit\n"
                "  python utils/load_comfy_models.py --edit-angle\n"
                "  python utils/load_comfy_models.py --img-edit --edit-angle\n"
                "  python utils/load_comfy_models.py --image-edit   # same as --img-edit\n"
                "  python utils/load_comfy_models.py --img-edit --hf-token hf_xxx"
            ),
            formatter_class=argparse.RawDescriptionHelpFormatter,
        )
        parser.add_argument(
            "--img-edit",
            "--image-edit",
            action="store_true",
            dest="img_edit",
            help=(
                "Download models for img_edit_service "
                "(image_qwen_image_edit_2509.json; 4 weights)"
            ),
        )
        parser.add_argument(
            "--edit-angle",
            action="store_true",
            dest="edit_angle",
            help=(
                "Download models for edit_angle_service "
                "(qwen_image_edit_angle_single.json; img-edit stack + multi-angle LoRA)"
            ),
        )
        parser.add_argument(
            "--force-redownload",
            action="store_true",
            help="Delete existing destination files and re-download HF weights (testing/repair)",
        )
        parser.add_argument(
            "--hf-token",
            type=str,
            help="Hugging Face API token (or set HF_TOKEN env var)",
        )
        return parser

    def run(self, argv: list[str] | None = None) -> int:
        parser = self.build_parser()
        args = parser.parse_args(argv)

        if not args.img_edit and not args.edit_angle:
            parser.print_help()
            print("\nError: specify --img-edit and/or --edit-angle.")
            return 1

        hf_token = args.hf_token or os.environ.get("HF_TOKEN")
        if not hf_token:
            print("\nWarning: No Hugging Face token provided. Some downloads may fail.")
            print("Get your token from: https://huggingface.co/settings/tokens\n")

        options = DownloadOptions(
            hf_token=hf_token,
            force_redownload=args.force_redownload,
            skip_ssl_verify=False,
        )
        selected = self.catalog.select(img_edit=args.img_edit, edit_angle=args.edit_angle)
        ok = self.orchestrator.download_group(
            "Comfy model download (deduplicated by destination path)",
            selected,
            options,
        )
        return 0 if ok else 1


def main() -> None:
    sys.exit(DownloadCLI().run())


if __name__ == "__main__":
    main()

