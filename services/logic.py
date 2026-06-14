"""
Character UI orchestration: subprocess calls to Comfy services and disk layout.

No Qt or Gradio. ComfyUI port from COMFY_PORT env only.
Required custom nodes install to ``comfyui/custom_nodes/`` before each Comfy launch.
"""

from __future__ import annotations

import filecmp
from collections import deque
import base64
import json
import logging
import math
import os
import re
import signal
import socket
import subprocess
import sys
import shutil
import tempfile
import zipfile
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

from services.character_storage import (
    DEFAULT_STORAGE_ROOT,
    download_url_to_file,
    ensure_dirs,
    get_character_paths,
    infer_ext_from_url,
    sanitize_for_folder,
    unique_suffix,
    write_multi_angle_appended_stem,
    write_base_image_from_url,
)
from services import prompts
from services.prompts import (
    ANIME_DEFAULT_STYLE_PREFIX,
    NEW_CHARACTER_POSITIVE_LEAD,
    POSE_KEYPOINT_CLOSEUP_PROMPT_SUFFIX,
    POSE_KEYPOINT_ONLY_ROLE_HINT,
    DEFAULT_KEYPOINT_ONLY_POSE_PROMPT,
    SHOT_PROMPT_PREFIX,
    SHOT_PROMPT_SCENE_JOINER,
    build_expression_prompt_from_label,
    build_pose_prompt_from_label,
    build_positive_prompt,
    build_shot_prompt,
    compose_new_character_positive_prompt,
    load_catalog as _load_catalog,
)
from services.sequence_gallery_strip import gallery_item_from_frame_urls

# Backward-compat private aliases for the keypoint-hint appenders (now centralized).
_append_closeup_keypoint_pose_hint = prompts.append_closeup_keypoint_pose_hint
_append_keypoint_only_pose_hint = prompts.append_keypoint_only_pose_hint

COMFY_PORT = int(os.environ.get("COMFY_PORT", 8188))

# Module-level ComfyUI process handle for crash recovery.
_comfy_proc: "subprocess.Popen | None" = None
_comfy_port: int = COMFY_PORT

# Reserved folder under ``DEFAULT_STORAGE_ROOT`` for React new-character drafts only.
NEW_CHARACTER_DRAFT_DIRNAME = "temp"

# Archived character base images (flat folder; not a character tile).
CHARACTER_ARCHIVE_DIRNAME = "character_archive"


def new_character_draft_dir() -> Path:
    """Workspace for ``base0``/``base1``/… before the user picks a final character name."""
    return DEFAULT_STORAGE_ROOT / NEW_CHARACTER_DRAFT_DIRNAME


def character_archive_dir() -> Path:
    return DEFAULT_STORAGE_ROOT / CHARACTER_ARCHIVE_DIRNAME


# Location React UI: shared drafts under ``locations/_drafts``; archive under ``locations/_location_archive``.
LOCATION_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "locations").resolve()
NEW_LOCATION_DRAFT_DIRNAME = "_drafts"
LOCATION_ARCHIVE_DIRNAME = "_location_archive"


def new_location_draft_dir() -> Path:
    return LOCATION_STORAGE_ROOT / NEW_LOCATION_DRAFT_DIRNAME


def location_archive_dir() -> Path:
    return LOCATION_STORAGE_ROOT / LOCATION_ARCHIVE_DIRNAME


_SERVICES_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SERVICES_DIR.parent

if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_REQUIRED_CUSTOM_NODES: list[dict[str, str]] = [
    {
        "name": "ComfyUI-RMBG",
        "repo": "https://github.com/1038lab/ComfyUI-RMBG",
        "dest_rel": "comfyui/custom_nodes/ComfyUI-RMBG",
        "requirements_rel": "comfyui/custom_nodes/ComfyUI-RMBG/requirements.txt",
        "marker_rel": "__init__.py",
    }
]

COMFY_CUSTOM_NODES_DIR = (_REPO_ROOT / "comfyui" / "custom_nodes").resolve()

# Prompt catalogs now live in services/prompts/ (re-exported here for back-compat).
POSE_PROMPTS_PATH = prompts.POSE_PROMPTS_PATH
EXPRESSION_PROMPTS_PATH = prompts.EXPRESSION_PROMPTS_PATH
CAMERA_ANGLES_PATH = prompts.CAMERA_ANGLES_PATH


@dataclass(frozen=True)
class CatalogOption:
    catalog_id: int
    catalog_index: int
    label: str
    prompt_text: str


def _build_options(catalog: list[dict[str, Any]]) -> dict[int, CatalogOption]:
    out: dict[int, CatalogOption] = {}
    for idx, row in enumerate(catalog):
        cid = row.get("id")
        label = row.get("label")
        prompt_text = row.get("prompt_text", "")
        if not isinstance(cid, int) or not isinstance(label, str):
            continue
        if not isinstance(prompt_text, str):
            prompt_text = ""
        out[cid] = CatalogOption(
            catalog_id=cid,
            catalog_index=idx,
            label=label,
            prompt_text=prompt_text,
        )
    return out


POSE_CATALOG = _load_catalog(POSE_PROMPTS_PATH) if POSE_PROMPTS_PATH.exists() else []
EXPRESSION_CATALOG = (
    _load_catalog(EXPRESSION_PROMPTS_PATH) if EXPRESSION_PROMPTS_PATH.exists() else []
)

POSE_BY_ID = _build_options(POSE_CATALOG)
EXPRESSION_BY_ID = _build_options(EXPRESSION_CATALOG)

# UI strips this prefix and replaces the last log line (tqdm refreshes in pipes are newline-delimited).
LOG_UI_REPLACE_LAST_PREFIX = "\x7fLOG_R\x7f"

_TQDM_PROGRESS_LINE_RE = re.compile(r"\d+%\|")
# Stable key for coalescing: description only, not "  2" vs "  3" before %|
_TQDM_STABLE_PREFIX_RE = re.compile(r"^(.*)\d+%\|")
# When tqdm has no desc, prefix is empty; still coalesce replace-last updates.
_TQDM_EMPTY_PFX_KEY = "\x7fTQDM_EMPTY_PFX\x7f"


def _is_tqdm_style_progress_line(s: str) -> bool:
    return bool(_TQDM_PROGRESS_LINE_RE.search(s))


def _tqdm_progress_line_prefix(s: str) -> str:
    m = _TQDM_STABLE_PREFIX_RE.match(s)
    if m:
        return m.group(1).rstrip()
    i = s.find("%")
    return s[:i].rstrip() if i != -1 else s.strip()


def _log_cb_coalesce_tqdm_updates(
    log_cb: Callable[[str], None],
) -> Callable[[str], None]:
    """Fold piped tqdm-style lines (many newlines) into logical single-line updates in the UI."""
    last_prefix: str | None = None

    def _inner(line: str) -> None:
        nonlocal last_prefix
        # Blank lines (often between tqdm metadata and the bar) must not reset
        # last_prefix or they break LOG_UI_REPLACE_LAST coalescing in the UI.
        if not line.strip():
            return
        s = line.rstrip("\r\n")
        segments = [p.strip() for p in s.split("\r") if p.strip()]
        if not segments:
            return
        for seg in segments:
            if _is_tqdm_style_progress_line(seg):
                pfx = _tqdm_progress_line_prefix(seg)
                key = pfx if pfx.strip() else _TQDM_EMPTY_PFX_KEY
                if key == last_prefix:
                    log_cb(LOG_UI_REPLACE_LAST_PREFIX + seg)
                else:
                    last_prefix = key
                    log_cb(seg)
            else:
                last_prefix = None
                log_cb(seg)

    return _inner


def _ensure_comfy_running(log_cb: Callable[[str], None] | None = None) -> None:
    """Restart ComfyUI if its process has exited, so service calls don't hang."""
    global _comfy_proc, _comfy_port
    if _comfy_proc is None:
        return  # Never launched by us — not our responsibility
    if _comfy_proc.poll() is None and _port_open("127.0.0.1", _comfy_port):
        return  # Still alive and reachable
    if log_cb:
        log_cb("ComfyUI process has exited — restarting...")
    _comfy_proc, _, _, _ = _launch_main_background(_comfy_port, log_cb=log_cb)
    deadline = time.time() + 120
    while time.time() < deadline:
        if _port_open("127.0.0.1", _comfy_port):
            if log_cb:
                log_cb(f"ComfyUI restarted and ready on port {_comfy_port}.")
            return
        time.sleep(0.5)
    raise RuntimeError("ComfyUI did not restart within 120 s.")


def _kill_comfy_proc(log_cb: Callable[[str], None] | None = None) -> None:
    """Terminate the ComfyUI process we launched (whole process group). Best-effort."""
    global _comfy_proc
    proc = _comfy_proc
    if proc is None:
        return
    try:
        if proc.poll() is None:
            if os.name != "nt":
                # Launched with start_new_session=True → its own process group.
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except Exception:
                    proc.terminate()
            else:
                proc.terminate()
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                if os.name != "nt":
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except Exception:
                        proc.kill()
                else:
                    proc.kill()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass
    except Exception as e:
        if log_cb:
            log_cb(f"Warning while stopping ComfyUI: {e}")
    finally:
        _comfy_proc = None


def _kill_port_listeners(port: int, log_cb: Callable[[str], None] | None = None) -> None:
    """
    Best-effort: kill any process tree LISTENing on ``port`` so a relaunch isn't blocked.
    Catches an externally-started ComfyUI or children that outlived the parent handle.
    """
    try:
        import psutil  # type: ignore
    except Exception:
        return
    pids: set[int] = set()
    try:
        for c in psutil.net_connections(kind="inet"):
            if (
                c.status == psutil.CONN_LISTEN
                and c.laddr
                and getattr(c.laddr, "port", None) == int(port)
                and c.pid
            ):
                pids.add(int(c.pid))
    except Exception as e:
        if log_cb:
            log_cb(f"Could not enumerate port {port} listeners: {e}")
        return
    for pid in pids:
        try:
            p = psutil.Process(pid)
            victims = p.children(recursive=True) + [p]
            for v in victims:
                try:
                    v.terminate()
                except Exception:
                    pass
            _gone, alive = psutil.wait_procs(victims, timeout=6)
            for v in alive:
                try:
                    v.kill()
                except Exception:
                    pass
            if log_cb:
                log_cb(f"Stopped process {pid} listening on port {port}.")
        except Exception:
            pass


def restart_comfy_server(
    *,
    log_cb: Callable[[str], None] | None = None,
    port: int = COMFY_PORT,
) -> dict[str, Any]:
    """Kill ComfyUI and relaunch it on ``port`` (default 8188); wait until reachable."""
    global _comfy_proc, _comfy_port
    port = int(port)
    _comfy_port = port

    if log_cb:
        log_cb(f"Stopping ComfyUI on port {port}…")
    _kill_comfy_proc(log_cb)
    _kill_port_listeners(port, log_cb)

    # Wait (briefly) for the port to actually free up.
    free_deadline = time.time() + 15
    while _port_open("127.0.0.1", port) and time.time() < free_deadline:
        time.sleep(0.3)

    if log_cb:
        log_cb("Launching ComfyUI…")
    proc, forward_logs, _comfy_tail, _comfy_tail_lock = _launch_main_background(port, log_cb=log_cb)
    _comfy_proc = proc

    deadline = time.time() + 120
    while time.time() < deadline:
        if _port_open("127.0.0.1", port):
            try:
                forward_logs.clear()
            except Exception:
                pass
            if log_cb:
                log_cb(f"ComfyUI is ready on 127.0.0.1:{port}.")
            return {"ok": True, "port": port}
        rc = proc.poll()
        if rc is not None:
            raise RuntimeError(
                f"ComfyUI exited before the server became reachable (exit code {rc}). "
                "See [comfy] lines above for the root cause."
            )
        time.sleep(0.5)
    raise RuntimeError("ComfyUI did not become reachable within 120 s.")


def _run_service_testmode(
    module: str,
    args: list[str],
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    _ensure_comfy_running(log_cb=log_cb)
    cmd = [sys.executable, "-m", module] + args
    proc = subprocess.Popen(
        cmd,
        cwd=str(_REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,  # line-buffered where possible
    )

    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def _reader(stream, sink: list[str]) -> None:
        try:
            for line in iter(stream.readline, ""):
                if line == "":
                    break
                sink.append(line)
                if log_cb is not None:
                    # Keep log payload compact and single-line per log_cb call.
                    log_cb(line.rstrip("\r\n"))
        finally:
            try:
                stream.close()
            except Exception:
                pass

    t_out = threading.Thread(
        target=_reader, args=(proc.stdout, stdout_lines), daemon=True
    )
    t_err = threading.Thread(
        target=_reader, args=(proc.stderr, stderr_lines), daemon=True
    )
    t_out.start()
    t_err.start()

    proc.wait()
    t_out.join()
    t_err.join()

    stdout = "".join(stdout_lines).strip() if stdout_lines else ""
    stderr = "".join(stderr_lines).strip() if stderr_lines else ""
    if proc.returncode != 0:
        combined_l = f"{stdout}\n{stderr}".lower()
        # ComfyUI-down path (common in --test-mode before we can queue a workflow):
        # - "waiting for server <addr> to start, .../120s"
        # - "server <addr> startup timeout, 120s"
        # - "ERROR: ComfyUI not reachable at <addr>"
        if (
            "comfyui not reachable" in combined_l
            or "comfyui not at" in combined_l
            or ("startup timeout" in combined_l and "waiting for server" in combined_l)
            or ("waiting for server" in combined_l and "startup timeout" in combined_l)
        ):
            raise RuntimeError(
                "ComfyUI Server Not Started: nothing responded while waiting for "
                f"127.0.0.1:{COMFY_PORT}. Start ComfyUI on that port or set COMFY_PORT "
                "to match your running instance."
            )
        raise RuntimeError(
            f"Service failed: {module}\nexit_code={proc.returncode}\nstdout={stdout}\nstderr={stderr}"
        )

    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        m = re.search(r"(\{[\s\S]*\})\s*$", stdout)
        if not m:
            raise RuntimeError(
                f"Could not parse service JSON output.\nstdout={stdout}\nstderr={stderr}"
            )
        return json.loads(m.group(1))


def _run_command_logged(
    cmd: list[str],
    *,
    cwd: Path,
    log_cb: Callable[[str], None] | None = None,
    env: dict[str, str] | None = None,
) -> None:
    if log_cb:
        log_cb("$ " + " ".join(cmd))
    popen_env = os.environ.copy()
    popen_env["PYTHONUTF8"] = "1"
    popen_env["PYTHONIOENCODING"] = "utf-8"
    if env:
        popen_env.update(env)
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=popen_env,
    )
    out_lines: list[str] = []
    assert proc.stdout is not None
    emit = _log_cb_coalesce_tqdm_updates(log_cb) if log_cb else None
    for line in iter(proc.stdout.readline, ""):
        if line == "":
            break
        out_lines.append(line)
        if emit:
            emit(line.rstrip("\r\n"))
    proc.stdout.close()
    proc.wait()
    if proc.returncode != 0:
        merged = "".join(out_lines).strip()
        raise RuntimeError(
            f"Command failed (exit {proc.returncode}): {' '.join(cmd)}\n{merged}"
        )


def _run_command_stream_no_echo(
    cmd: list[str],
    *,
    cwd: Path,
    log_cb: Callable[[str], None] | None = None,
    env: dict[str, str] | None = None,
) -> str:
    """
    Like _run_command_logged, but never prints the command line (useful for secrets).
    Returns merged output (stdout+stderr).
    """
    popen_env = os.environ.copy()
    popen_env["PYTHONUTF8"] = "1"
    popen_env["PYTHONIOENCODING"] = "utf-8"
    if env:
        popen_env.update(env)
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=popen_env,
    )
    out_lines: list[str] = []
    assert proc.stdout is not None
    emit = _log_cb_coalesce_tqdm_updates(log_cb) if log_cb else None
    for line in iter(proc.stdout.readline, ""):
        if line == "":
            break
        out_lines.append(line)
        if emit:
            emit(line.rstrip("\r\n"))
    proc.stdout.close()
    proc.wait()
    merged = "".join(out_lines).strip()
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed (exit {proc.returncode}).\n{merged}")
    return merged


def _git_origin_url() -> str:
    out = subprocess.check_output(
        ["git", "remote", "get-url", "origin"],
        cwd=str(_REPO_ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return (out or "").strip()


def _git_lfs_pull_with_github_pat(
    github_pat: str,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    pat = (github_pat or "").strip()
    if not pat:
        raise ValueError("Please enter GitHub Personal Access Token (PAT).")

    # Ensure git-lfs exists and is callable.
    try:
        subprocess.check_call(["git", "lfs", "version"], cwd=str(_REPO_ROOT))
    except Exception as e:
        raise RuntimeError("git-lfs is not installed or not usable.") from e

    origin = _git_origin_url()
    if not origin:
        raise RuntimeError("Could not determine git remote origin URL.")

    if origin.startswith("git@") or origin.startswith("ssh://"):
        # SSH remotes should work with SSH keys; PAT isn't required in that case.
        if log_cb:
            log_cb("Git remote is SSH; skipping PAT-based LFS auth step.")
        _run_command_stream_no_echo(
            ["git", "lfs", "pull"],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
            env={"GIT_TERMINAL_PROMPT": "0"},
        )
        return

    if not origin.startswith("http://") and not origin.startswith("https://"):
        raise RuntimeError(f"Unsupported git remote scheme for origin: {origin!r}")

    u = urllib.parse.urlparse(origin)
    if not u.netloc or not u.path:
        raise RuntimeError("Invalid origin URL; cannot run authenticated LFS pull.")

    # For GitHub HTTPS, PAT can be supplied as the password; username can be anything.
    safe_user = "x-access-token"
    netloc = u.hostname or u.netloc
    if u.port:
        netloc = f"{netloc}:{u.port}"
    auth_netloc = f"{safe_user}:{urllib.parse.quote(pat, safe='')}@{netloc}"
    auth_url = urllib.parse.urlunparse(
        (u.scheme, auth_netloc, u.path, u.params, u.query, u.fragment)
    )

    if log_cb:
        log_cb("Fetching Git LFS assets (git lfs pull)...")

    # Avoid printing commands containing the token.
    try:
        subprocess.check_call(
            ["git", "remote", "set-url", "origin", auth_url], cwd=str(_REPO_ROOT)
        )
        _run_command_stream_no_echo(
            ["git", "lfs", "pull"],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
            env={"GIT_TERMINAL_PROMPT": "0"},
        )
    finally:
        try:
            subprocess.check_call(
                ["git", "remote", "set-url", "origin", origin], cwd=str(_REPO_ROOT)
            )
        except Exception:
            # Best-effort restore; avoid masking original failure.
            pass

def _port_open(host: str, port: int, timeout_s: float = 0.6) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout_s)
    try:
        sock.connect((host, int(port)))
        return True
    except Exception:
        return False
    finally:
        try:
            sock.close()
        except Exception:
            pass


def _pip_check_ok(log_cb: Callable[[str], None] | None = None) -> bool:
    """Run ``pip check`` and return *True* unless a package from requirements.txt is broken.

    Stale / leftover packages not listed in requirements.txt (e.g. ``decord``)
    may legitimately fail ``pip check`` without affecting the app.  We only
    treat it as a real failure when a *required* package is reported.
    """
    req_path = _REPO_ROOT / "requirements.txt"
    required_names: set[str] = set()
    if req_path.is_file():
        for raw in req_path.read_text(encoding="utf-8").splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            name = re.split(r"[><=!~\[;]", line, maxsplit=1)[0].strip().lower()
            if name:
                required_names.add(name)

    proc = subprocess.Popen(
        [sys.executable, "-m", "pip", "check"],
        cwd=str(_REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdout is not None
    out = proc.stdout.read()
    proc.stdout.close()
    proc.wait()

    if log_cb:
        log_cb("$ " + " ".join([sys.executable, "-m", "pip", "check"]))
        for line in out.strip().splitlines():
            log_cb(line)

    if proc.returncode == 0:
        return True

    failed_required = False
    for line in out.strip().splitlines():
        pkg_name = re.split(r"\s+", line, maxsplit=1)[0].strip().lower()
        if pkg_name in required_names:
            failed_required = True
            break

    if not failed_required:
        if log_cb:
            log_cb("pip check reported issues only in non-required packages; continuing.")
        return True

    return False


def _quick_env_check(log_cb: Callable[[str], None] | None = None) -> bool:
    try:
        _run_command_logged(
            [
                sys.executable,
                "-c",
                (
                    "import cv2, skimage; "
                    "print('import check ok')"
                ),
            ],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )
        if not _pip_check_ok(log_cb=log_cb):
            return False
        return True
    except Exception:
        return False


def _custom_node_installed(dest: Path, marker: str) -> bool:
    """True when ``dest`` contains ``marker`` (non-empty install, not a bare directory)."""
    marker_path = dest / marker
    return marker_path.is_file()


def install_required_custom_nodes(
    *, log_cb: Callable[[str], None] | None = None
) -> None:
    """
    Ensure required ComfyUI custom nodes are installed under ``comfyui/custom_nodes/``.

    ``comfyui/custom_nodes/`` is gitignored; nodes are cloned at runtime (or image build).
    """
    COMFY_CUSTOM_NODES_DIR.mkdir(parents=True, exist_ok=True)
    legacy_root = (_REPO_ROOT / "custom_nodes").resolve()

    for node in _REQUIRED_CUSTOM_NODES:
        name = node["name"]
        repo = node["repo"]
        dest = (_REPO_ROOT / node["dest_rel"]).resolve()
        req = (_REPO_ROOT / node["requirements_rel"]).resolve()
        marker = (node.get("marker_rel") or "__init__.py").strip()

        legacy_dest = legacy_root / dest.name
        if legacy_dest.exists() and not _custom_node_installed(dest, marker):
            if log_cb:
                log_cb(f"Removing legacy custom node path: {legacy_dest}")
            shutil.rmtree(legacy_dest, ignore_errors=True)

        if dest.exists() and not _custom_node_installed(dest, marker):
            if log_cb:
                log_cb(f"Repairing broken custom node install: {name}")
            shutil.rmtree(dest, ignore_errors=True)

        if _custom_node_installed(dest, marker):
            if log_cb:
                log_cb(f"Custom node already present: {name}")
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if log_cb:
                log_cb(f"Installing Comfy custom node: {name}")
            _run_command_logged(
                ["git", "clone", "--depth", "1", repo, str(dest)],
                cwd=_REPO_ROOT,
                log_cb=log_cb,
            )

        if req.is_file():
            if log_cb:
                log_cb(f"Installing custom node deps: {name}")
            _run_command_logged(
                [sys.executable, "-m", "pip", "install", "-r", str(req)],
                cwd=_REPO_ROOT,
                log_cb=log_cb,
            )


def _launch_main_background(
    port: int,
    log_cb: Callable[[str], None] | None = None,
) -> tuple[subprocess.Popen, threading.Event, deque[str], threading.Lock]:
    """Start Comfy ``main.py`` in the background; stream stdout/stderr via pipe while ``forward_logs`` is set."""
    install_required_custom_nodes(log_cb=log_cb)
    (_REPO_ROOT / "comfyui" / "custom_nodes").mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(_REPO_ROOT / "comfyui" / "main.py"),
        "--disable-metadata",
        "--port",
        str(int(port)),
    ]
    # Disable Comfy's intermediate node cache to avoid cached-success runs with
    # empty history outputs and identical multi-angle results.  Users who want
    # caching back can set COMFY_CACHE_ENABLE=1.
    cache_on = (os.environ.get("COMFY_CACHE_ENABLE") or "").strip().lower() in {
        "1", "true", "yes", "y", "on",
    }
    if not cache_on:
        cmd.append("--cache-none")
    # Async weight offloading is unstable with legacy ModelPatcher (PyTorch < 2.8).
    cmd.append("--disable-async-offload")
    # Offload models to CPU between pipeline stages to prevent OOM on 24 GB cards
    # when loading the BF16→FP8 diffusion model alongside the 7.9 GB text encoder.
    cmd.append("--lowvram")
    if log_cb:
        log_cb("$ " + " ".join(cmd))
    popen_env = os.environ.copy()
    popen_env["PYTHONUTF8"] = "1"
    popen_env["PYTHONIOENCODING"] = "utf-8"
    forward_logs = threading.Event()
    forward_logs.set()
    comfy_tail: deque[str] = deque(maxlen=80)
    tail_lock = threading.Lock()
    kwargs: dict[str, Any] = {
        "cwd": str(_REPO_ROOT / "comfyui"),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
        "env": popen_env,
        "start_new_session": True,
    }
    if os.name == "nt":
        # CREATE_NEW_PROCESS_GROUP: Ctrl+C isolation. Omit DETACHED_PROCESS so stdio pipes work reliably.
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        kwargs["creationflags"] = flags
    proc = subprocess.Popen(cmd, **kwargs)

    def _reader() -> None:
        assert proc.stdout is not None
        try:
            for line in iter(proc.stdout.readline, ""):
                if line == "":
                    break
                stripped = line.rstrip("\r\n")
                if not stripped:
                    continue
                with tail_lock:
                    comfy_tail.append(stripped)
                if forward_logs.is_set() and log_cb is not None:
                    log_cb("[comfy] " + stripped)
        finally:
            try:
                proc.stdout.close()
            except Exception:
                pass

    threading.Thread(target=_reader, daemon=True).start()
    return proc, forward_logs, comfy_tail, tail_lock


def run_startup_setup_and_launch(
    *,
    hf_token: str,
    github_pat: str,
    log_cb: Callable[[str], None] | None = None,
    port: int = COMFY_PORT,
) -> dict[str, Any]:
    token = (hf_token or "").strip()
    if not token:
        raise ValueError("please enter hf token for downloading model from huggingFace")
    pat = (github_pat or "").strip()
    if not pat:
        raise ValueError("Please enter GitHub Personal Access Token (PAT).")

    if _port_open("127.0.0.1", int(port)):
        if log_cb:
            log_cb(f"ComfyUI already running at 127.0.0.1:{int(port)}")
        return {"ok": True, "already_running": True, "port": int(port)}

    # Git LFS assets (images/datasets/etc.) are required for a usable UI.
    _git_lfs_pull_with_github_pat(pat, log_cb=log_cb)

    if log_cb:
        log_cb("Running quick dependency check...")
    env_ok = _quick_env_check(log_cb=log_cb)
    if not env_ok:
        if log_cb:
            log_cb("Quick check failed. Repairing environment...")
        _run_command_logged(
            [sys.executable, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )
        try:
            _run_command_logged(
                [
                    sys.executable,
                    "-c",
                    "import torch, torchvision, torchaudio; print('torch ok')",
                ],
                cwd=_REPO_ROOT,
                log_cb=log_cb,
            )
        except Exception:
            _run_command_logged(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "torch==2.6.0+cu124",
                    "torchvision==0.21.0+cu124",
                    "torchaudio==2.6.0+cu124",
                    "--index-url",
                    "https://download.pytorch.org/whl/cu124",
                ],
                cwd=_REPO_ROOT,
                log_cb=log_cb,
            )
        _run_command_logged(
            [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )
        _run_command_logged(
            [sys.executable, "-m", "pip", "install",
             "comfyui-frontend-package==1.43.18",
             "comfyui-workflow-templates==0.9.75",
             "comfyui-embedded-docs==0.5.0"],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )
        if not _pip_check_ok(log_cb=log_cb) and log_cb:
            log_cb("Warning: pip check still reports issues after repair; continuing anyway.")
    else:
        if log_cb:
            log_cb("Quick check passed. Skipping reinstall.")
        _run_command_logged(
            [sys.executable, "-m", "pip", "install",
             "comfyui-frontend-package==1.43.18",
             "comfyui-workflow-templates==0.9.75",
             "comfyui-embedded-docs==0.5.0"],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )

    # Build deps for kimodo's MotionCorrection C extension (CMake + Python dev headers).
    py_tag = f"{sys.version_info.major}.{sys.version_info.minor}"
    _run_command_logged(
        ["apt-get", "install", "-y", "cmake", "build-essential", f"python{py_tag}-dev"],
        cwd=_REPO_ROOT,
        log_cb=log_cb,
    )

    # Install kimodo (nv-tlabs/kimodo) if not already present — clone then editable-install.
    kimodo_dir = _REPO_ROOT / "kimodo"
    if not (kimodo_dir / "setup.py").is_file() and not (kimodo_dir / "pyproject.toml").is_file():
        if log_cb:
            log_cb("Cloning nv-tlabs/kimodo…")
        _run_command_logged(
            ["git", "clone", "https://github.com/nv-tlabs/kimodo.git", str(kimodo_dir)],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )
    try:
        import motion_correction  # noqa: F401 — C extension built by kimodo setup
        import kimodo  # noqa: F401
    except ImportError:
        if log_cb:
            log_cb("Installing kimodo (editable, with MotionCorrection C extension)…")
        _run_command_logged(
            [sys.executable, "-m", "pip", "install", "-e", str(kimodo_dir)],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )

    # smplx: skins the kimodo SMPL-X motion into a white body mesh for the viewer.
    # Requires the SMPL-X body model staged at $SMPLX_MODEL_DIR/smplx/SMPLX_NEUTRAL.npz
    # (default storage/body_models/smplx/), which must be provided separately (licensed asset).
    try:
        import smplx  # noqa: F401
    except ImportError:
        if log_cb:
            log_cb("Installing smplx (SMPL-X mesh skinning)…")
        _run_command_logged(
            [sys.executable, "-m", "pip", "install", "smplx>=0.1.28"],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )

    # SMPL-X body model (Git LFS): motion-ref mesh skinning needs the licensed npz on disk.
    try:
        from services.motion_ref_gen_ai_service.smplx_skinning import smplx_body_model_ready

        if not smplx_body_model_ready():
            if log_cb:
                log_cb(
                    "Warning: SMPL-X body model missing or not pulled (Git LFS). "
                    "KiMoD motion will generate joints but no mesh until you run: "
                    "git lfs install && git lfs pull "
                    "(storage/body_models/smplx/SMPLX_NEUTRAL.npz, ~104 MB)."
                )
            if sys.platform.startswith("linux") and shutil.which("git") and not shutil.which("git-lfs"):
                if log_cb:
                    log_cb("Installing git-lfs (apt) so SMPL-X LFS assets can be pulled…")
                _run_command_logged(
                    ["apt-get", "install", "-y", "git-lfs"],
                    cwd=_REPO_ROOT,
                    log_cb=log_cb,
                )
                _run_command_logged(
                    ["git", "lfs", "install"],
                    cwd=_REPO_ROOT,
                    log_cb=log_cb,
                )
    except Exception:
        pass

    # Custom nodes are installed in _launch_main_background before Comfy starts.

    env = os.environ.copy()
    env["HF_TOKEN"] = token
    _run_command_logged(
        [
            sys.executable,
            "utils/download_models.py",
            "--all",
        ],
        cwd=_REPO_ROOT,
        log_cb=log_cb,
        env=env,
    )

    global _comfy_proc, _comfy_port
    _comfy_port = int(port)
    proc, forward_logs, comfy_tail, comfy_tail_lock = _launch_main_background(
        int(port), log_cb=log_cb
    )
    _comfy_proc = proc
    if log_cb:
        log_cb("Waiting for ComfyUI to become reachable (no timeout)...")
    wait_log_t0 = time.time()
    while True:
        if _port_open("127.0.0.1", int(port)):
            forward_logs.clear()
            if log_cb:
                log_cb(f"ComfyUI is ready at 127.0.0.1:{int(port)}")
            return {"ok": True, "already_running": False, "port": int(port)}
        rc = proc.poll()
        if rc is not None:
            with comfy_tail_lock:
                tail_snapshot = list(comfy_tail)
            parts = [
                f"ComfyUI exited before the server became reachable (exit code {rc}).",
                "See [comfy] lines above for the root cause.",
            ]
            if tail_snapshot:
                parts.append("--- Comfy log tail ---\n" + "\n".join(tail_snapshot))
            raise RuntimeError("\n".join(parts))
        if log_cb and (time.time() - wait_log_t0) >= 60.0:
            log_cb(f"Still waiting for ComfyUI on 127.0.0.1:{int(port)}...")
            wait_log_t0 = time.time()
        time.sleep(1.0)


def _extract_image_url_from_anime_results(body: dict[str, Any]) -> str:
    results = body.get("results") or []
    if not results:
        raise RuntimeError("Anime service returned no results.")
    first = results[0] or {}
    url = first.get("url")
    if isinstance(url, str) and url:
        return url
    local_path = first.get("local_path")
    if isinstance(local_path, str) and local_path:
        return local_path
    raise RuntimeError("Anime service result missing `url` or `local_path`.")


def _extract_image_urls_from_image_edit(body: dict[str, Any]) -> list[str]:
    results = body.get("results") or []
    out: list[str] = []
    for r in results:
        url = r.get("url")
        if isinstance(url, str) and url:
            out.append(url)
    return out


def _run_image_edit_inline_prompt(
    *,
    input_image_abs_path: str,
    prompt_text: str,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run image edit service using `prompt-source=inline` for a single prompt.

    Returns the first output image URL from the service results.
    """
    if not input_image_abs_path:
        raise ValueError("input_image_abs_path is required.")
    src = Path(input_image_abs_path)
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")

    effective = (prompt_text or "").strip()
    if not effective:
        raise ValueError("prompt_text is required.")

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            input_image_abs_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps([effective]),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    urls = _extract_image_urls_from_image_edit(body)
    if not urls:
        raise RuntimeError("Image-edit returned no image URLs.")
    return urls[0]


def _run_inline_edit_or_mask(
    *,
    input_image_abs_path: str,
    prompt_text: str,
    mask_abs_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Route an inline AI edit to the right service.

    If ``mask_abs_path`` is given, the edit is region-limited and routed to the
    Flux.1 Fill mask-guided service (:func:`run_mask_guided_edit`); the painted
    region of the mask (white) is regenerated and the rest is preserved. With no
    mask, the full image is edited via the Qwen image-edit service
    (:func:`_run_image_edit_inline_prompt`). Both arms return an image URL/path.
    """
    if mask_abs_path:
        return run_mask_guided_edit(
            input_image_abs_path=input_image_abs_path,
            mask_abs_path=mask_abs_path,
            prompt_text=prompt_text,
            log_cb=log_cb,
        )
    return _run_image_edit_inline_prompt(
        input_image_abs_path=input_image_abs_path,
        prompt_text=prompt_text,
        log_cb=log_cb,
    )


def decode_mask_png_to_temp_file(mask_png_base64: str | None) -> str | None:
    """
    Decode a base64 mask PNG (as produced by the AI Edit mask canvas) to a temp
    ``.png`` and return its path, or ``None`` when no mask was supplied. Painted
    pixels are white; :func:`run_mask_guided_edit` treats white as the region to
    regenerate. The caller is responsible for unlinking the returned path.
    """
    b64 = (mask_png_base64 or "").strip()
    if not b64:
        return None
    if b64.lower().startswith("data:") and "," in b64:
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    dest = Path(tempfile.gettempdir()) / f"ai_edit_mask_{unique_suffix()}.png"
    dest.write_bytes(raw)
    return str(dest)


def run_qwen_t2i(
    *,
    prompt_text: str,
    width: int = 1024,
    height: int = 1024,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Generate a Qwen-Image 2512 text-to-image via the t2i_ref_gen service (test-mode).

    Accepts a text prompt plus output width/height; all other inputs (seed,
    steps, cfg, sampler, models) are defaulted by the workflow. Returns the
    first output image reference (URL when S3 is configured, else a local path).
    """
    effective = (prompt_text or "").strip()
    if not effective:
        raise ValueError("prompt_text is required.")

    body = _run_service_testmode(
        "services.t2i_ref_gen_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--prompt",
            effective,
            "--width",
            str(int(width)),
            "--height",
            str(int(height)),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    results = body.get("results") or []
    for r in results:
        if isinstance(r, dict):
            ref = r.get("url") or r.get("local_path")
            if isinstance(ref, str) and ref:
                return ref
    raise RuntimeError("Qwen t2i returned no image.")


def run_mask_guided_edit(
    *,
    input_image_abs_path: str,
    mask_abs_path: str,
    prompt_text: str,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run a mask-guided inpaint via the mask_guided_edit service (Flux.1 Fill).

    The service is mask-unaware: ComfyUI's LoadImage derives its MASK output as
    ``1 - alpha`` of the loaded image. So this helper bakes ``mask_abs_path`` into
    the alpha channel of ``input_image_abs_path`` first, then sends the merged
    RGBA PNG as the single ``--image-url`` input.

    Mask convention: the painted/white region of ``mask_abs_path`` is the area to
    regenerate, so it becomes ``alpha=0`` (transparent); the kept region stays
    ``alpha=255``. If an incoming mask uses the opposite convention, flip the
    ``ImageChops.invert(mask)`` line below.

    Returns the first output image reference (URL when S3 is configured, else a
    local path).
    """
    from PIL import Image, ImageChops

    if not input_image_abs_path:
        raise ValueError("input_image_abs_path is required.")
    src = Path(input_image_abs_path)
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")

    if not mask_abs_path:
        raise ValueError("mask_abs_path is required.")
    mask_p = Path(mask_abs_path)
    if not mask_p.is_file():
        raise ValueError(f"Mask image not found: {mask_p}")

    effective = (prompt_text or "").strip()
    if not effective:
        raise ValueError("prompt_text is required.")

    # Bake the mask into the alpha channel: white (edit) -> alpha 0, black -> 255.
    base = Image.open(src).convert("RGBA")
    mask = Image.open(mask_p).convert("L").resize(base.size)
    alpha = ImageChops.invert(mask)
    base.putalpha(alpha)
    merged_path = Path(tempfile.gettempdir()) / f"mask_edit_{unique_suffix()}.png"
    base.save(merged_path, format="PNG")

    body = _run_service_testmode(
        "services.mask_guided_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            str(merged_path),
            "--prompt",
            effective,
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    results = body.get("results") or []
    for r in results:
        if isinstance(r, dict):
            ref = r.get("url") or r.get("local_path")
            if isinstance(ref, str) and ref:
                return ref
    raise RuntimeError("Mask-guided edit returned no image.")


def _run_image_edit_inline_prompt_with_aux(
    *,
    input_image_abs_path: str,
    auxiliary_image_abs_paths: list[str],
    prompt_text: str,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run image edit (`prompt-source=inline`) with a primary image plus up to two
    auxiliary images.

    The primary ``input_image_abs_path`` maps to the workflow's first LoadImage
    node (Qwen image1); auxiliary paths map to image2/image3 in order. Returns
    the first output image URL from the service results.
    """
    if not input_image_abs_path:
        raise ValueError("input_image_abs_path is required.")
    src = Path(input_image_abs_path)
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")

    aux_paths = [str(p) for p in (auxiliary_image_abs_paths or []) if p]
    for p in aux_paths:
        if not Path(p).is_file():
            raise ValueError(f"Auxiliary image not found: {p}")
    aux_paths = aux_paths[:2]

    effective = (prompt_text or "").strip()
    if not effective:
        raise ValueError("prompt_text is required.")

    args = [
        "--test-mode",
        "--enable-default",
        "--default-port",
        str(COMFY_PORT),
        "--image-url",
        input_image_abs_path,
        "--prompt-source",
        "inline",
        "--prompts-json",
        json.dumps([effective]),
        "--convert-local-to-url",
    ]
    if aux_paths:
        args += ["--auxiliary-image-urls-json", json.dumps(aux_paths)]

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        args,
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    urls = _extract_image_urls_from_image_edit(body)
    if not urls:
        raise RuntimeError("Image-edit returned no image URLs.")
    return urls[0]


def create_shot(
    *,
    shot_name: str,
    backdrop_abs_path: str,
    composite_abs_path: str,
    location_key: str | None = None,
    location_image_rel_path: str | None = None,
    characters: list[dict[str, Any]] | None = None,
    prompt_text: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, str]:
    """
    Generate a film shot via Qwen image-edit with two image inputs.

    ``backdrop_abs_path`` (image 1) is the pristine location image and
    ``composite_abs_path`` (image 2) is the flattened backdrop+character overlay
    rendered client-side. Saves ``generated.png`` + ``metadata.json`` under
    ``storage/shots/<shot_key>/`` and returns relative paths for the UI.
    """
    import datetime as _dt

    from services import shot_storage
    from services.character_storage import (
        ensure_dirs,
        infer_ext_from_url,
        download_url_to_file,
    )

    name = (shot_name or "").strip()
    if not name:
        raise ValueError("shot_name is required.")
    backdrop = Path(backdrop_abs_path)
    composite = Path(composite_abs_path)
    if not backdrop.is_file():
        raise ValueError(f"Backdrop image not found: {backdrop}")
    if not composite.is_file():
        raise ValueError(f"Composite image not found: {composite}")

    prompt = build_shot_prompt(prompt_text)
    if log_cb:
        log_cb(f"Creating shot '{name}' with Qwen image-edit (2 image inputs).")

    result_url = _run_image_edit_inline_prompt_with_aux(
        input_image_abs_path=str(backdrop),
        auxiliary_image_abs_paths=[str(composite)],
        prompt_text=prompt,
        log_cb=log_cb,
    )

    out_dir = shot_storage.shot_dir(name)
    ensure_dirs(out_dir)
    # Persist the exact inputs alongside the result for traceability.
    shutil.copy2(backdrop, out_dir / f"backdrop{backdrop.suffix.lower() or '.png'}")
    shutil.copy2(composite, out_dir / f"composite{composite.suffix.lower() or '.png'}")
    ext = infer_ext_from_url(result_url)
    generated = out_dir / f"generated{ext}"
    download_url_to_file(result_url, generated)

    metadata = {
        "shotName": name,
        "locationKey": location_key,
        "locationImageRelPath": location_image_rel_path,
        "characters": characters or [],
        "prompt": (prompt_text or "").strip(),
        "prependedPrompt": prompt,
        "createdAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "outputRelPath": _shot_rel_from_abs(generated),
    }
    (out_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    if log_cb:
        log_cb(f"Shot saved to {out_dir}")

    return {
        "shotKey": out_dir.name,
        "outputRelPath": _shot_rel_from_abs(generated),
    }


def save_shot_as_is(
    *,
    shot_name: str,
    backdrop_abs_path: str,
    composite_abs_path: str,
    location_key: str | None = None,
    location_image_rel_path: str | None = None,
    characters: list[dict[str, Any]] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, str]:
    """
    Save a shot directly from the flattened composite, without running any AI.

    The preview overlay (``composite_abs_path``) becomes the shot's output image
    verbatim. Saves ``generated.png`` + ``metadata.json`` (``mode == "as_is"``)
    under ``storage/shots/<shot_key>/`` and returns relative paths for the UI.
    """
    import datetime as _dt

    from services import shot_storage
    from services.character_storage import ensure_dirs

    name = (shot_name or "").strip()
    if not name:
        raise ValueError("shot_name is required.")
    backdrop = Path(backdrop_abs_path)
    composite = Path(composite_abs_path)
    if not backdrop.is_file():
        raise ValueError(f"Backdrop image not found: {backdrop}")
    if not composite.is_file():
        raise ValueError(f"Composite image not found: {composite}")

    if log_cb:
        log_cb(f"Saving shot '{name}' as-is (no AI edit).")

    out_dir = shot_storage.shot_dir(name)
    ensure_dirs(out_dir)
    # Persist the exact inputs alongside the output for traceability.
    shutil.copy2(backdrop, out_dir / f"backdrop{backdrop.suffix.lower() or '.png'}")
    shutil.copy2(composite, out_dir / f"composite{composite.suffix.lower() or '.png'}")
    # The flattened overlay *is* the output for an as-is save.
    generated = out_dir / "generated.png"
    shutil.copy2(composite, generated)

    metadata = {
        "shotName": name,
        "locationKey": location_key,
        "locationImageRelPath": location_image_rel_path,
        "characters": characters or [],
        "prompt": "",
        "prependedPrompt": "",
        "mode": "as_is",
        "createdAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "outputRelPath": _shot_rel_from_abs(generated),
    }
    (out_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    if log_cb:
        log_cb(f"Shot saved to {out_dir}")

    return {
        "shotKey": out_dir.name,
        "outputRelPath": _shot_rel_from_abs(generated),
    }


def _shot_rel_from_abs(abs_path: Path) -> str:
    """Storage-relative path (``shots/<key>/...``) for a file under the shots root."""
    from services import shot_storage

    try:
        rel = Path(abs_path).resolve().relative_to(shot_storage.SHOTS_STORAGE_ROOT)
        return str(Path("shots") / rel).replace("\\", "/")
    except Exception:
        return Path(abs_path).name


def _extract_single_result_url_from_multi_angle(body: dict[str, Any]) -> str:
    variations = body.get("variations") or {}
    items = variations.get("items") or []
    if not items:
        raise RuntimeError("Multi-angle service returned no variations/items.")
    result = items[0].get("result") or {}
    url = result.get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError("Multi-angle service result missing `url`.")
    return url


def _find_first_matching_image(dir_path: Path, prefix: str) -> Path | None:
    if not dir_path.exists():
        return None
    for p in sorted(dir_path.glob(prefix + ".*")):
        if p.is_file():
            return p
    return None


def _character_list(storage_root: Path = DEFAULT_STORAGE_ROOT) -> list[str]:
    if not storage_root.exists():
        return []
    skip = {NEW_CHARACTER_DRAFT_DIRNAME, CHARACTER_ARCHIVE_DIRNAME}
    return sorted(
        [p.name for p in storage_root.iterdir() if p.is_dir() and p.name not in skip]
    )


def character_cover_gallery_payload() -> tuple[list[tuple[str, str]], list[str]]:
    items: list[tuple[str, str]] = []
    keys: list[str] = []
    for k in _character_list():
        character = get_character_paths(k)
        base = _character_cover_image_path(k)
        if base is None:
            continue
        items.append((str(base), k))
        keys.append(k)
    return items, keys


def list_character_image_paths(char_key: str) -> list[str]:
    """
    Return all image files currently available for a character.

    This is used by the in-app "add image" chooser since pose/expression generation
    are image-to-image operations.
    """
    character = get_character_paths(char_key)
    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    roots: list[Path] = [
        character.base_dir,
        character.poses_dir,
        character.expressions_dir,
    ]

    out: list[str] = []
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in exts:
                out.append(str(p))
    return sorted(out)


def character_base_image_path(char_key: str) -> str | None:
    """Absolute path to the character's canonical base image, or None."""
    base = _character_cover_image_path(char_key)
    return str(base) if base is not None else None


def character_detail_gate_preview_path(char_key: str) -> str | None:
    """
    Absolute path for the character detail gate preview: ``base_combined`` (body + 4-up)
    when present, else the same canonical base as :func:`character_base_image_path`.
    """
    character = get_character_paths(char_key)
    combined = _find_first_matching_image(character.base_dir, "base_combined")
    if combined is not None and combined.is_file():
        return str(combined.resolve())
    return character_base_image_path(char_key)


def _character_root_image_stems_ordered() -> list[str]:
    """Stems used for hub/detail cover only (full-body). ``base_combined`` is excluded."""
    return [
        "base_img",
        "base",
    ]


def _find_character_root_image_by_stem(char_key: str, stem: str) -> Path | None:
    character = get_character_paths(char_key)
    return _find_first_matching_image(character.base_dir, stem)


def _character_cover_image_path(char_key: str) -> Path | None:
    for stem in _character_root_image_stems_ordered():
        p = _find_character_root_image_by_stem(char_key, stem)
        if p is not None:
            return p
    return None


def character_base_source_image_path(char_key: str) -> str | None:
    """
    Absolute path to the root source image used for closeup generation.
    Prefers ``base_img.*`` then falls back to legacy ``base.*``.
    """
    p = _find_character_root_image_by_stem(char_key, "base_img")
    if p is None:
        p = _find_character_root_image_by_stem(char_key, "base")
    return str(p) if p is not None else None


def _paths_same_file_or_identical_bytes(a: Path, b: Path) -> bool:
    try:
        if a.samefile(b):
            return True
    except OSError:
        pass
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
    except OSError:
        return False
    return bool(filecmp.cmp(a, b, shallow=False))


def dedupe_identical_image_paths(paths: list[str]) -> list[str]:
    """
    Keep paths in order; drop any path whose file content matches an earlier kept path
    (same inode or byte-identical). Fixes duplicate thumbnails for base vs starting_image copies.
    """
    out: list[str] = []
    for s in paths:
        p = Path(s)
        if not p.is_file():
            continue
        if any(_paths_same_file_or_identical_bytes(p, Path(keep)) for keep in out):
            continue
        out.append(s)
    return out


def list_character_image_paths_deduped(char_key: str) -> list[str]:
    """
    All character images with byte-identical duplicates removed (first path in sort order kept).
    """
    raw = list_character_image_paths(char_key)
    return dedupe_identical_image_paths(sorted(raw))


def character_image_chooser_caption(char_key: str, path: str) -> str:
    """
    Short label for ImageChooserDialog: pose/expression folder names instead of ``starting_image.*``.
    """
    character = get_character_paths(char_key)
    p = Path(path)
    if not p.is_file():
        return p.name
    try:
        char_dir = character.character_dir.resolve()
        rp = p.resolve()
        rel = rp.relative_to(char_dir)
    except (ValueError, OSError):
        return p.name
    parts = rel.parts
    if not parts:
        return p.name
    top = parts[0].lower()
    fn = p.name
    fn_lower = fn.lower()
    if top == "poses" and len(parts) >= 2:
        pose_key = parts[1]
        if fn_lower.startswith("starting_image"):
            return pose_key
        return f"{pose_key} / {fn}"
    if top == "expressions" and len(parts) >= 2:
        expr_key = parts[1]
        if fn_lower.startswith("starting_image"):
            return expr_key
        return f"{expr_key} / {fn}"
    if len(parts) == 1 and p.stem.lower() in {"base", "base_img"}:
        return "Character base"
    if len(parts) == 1 and p.stem.lower() == "base_combined":
        return "Character cover"
    if len(parts) == 1 and p.stem.lower() == "base_closeup":
        return "Character closeup grid"
    return fn


def character_image_chooser_captions(char_key: str, paths: list[str]) -> list[str]:
    return [character_image_chooser_caption(char_key, p) for p in paths]


def _load_camera_angles(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


CAMERA_ANGLES_RAW = _load_camera_angles(CAMERA_ANGLES_PATH)
CAMERA_ANGLE_BY_ID: dict[int, dict[str, Any]] = {}
for _row in CAMERA_ANGLES_RAW:
    _aid = _row.get("id")
    if isinstance(_aid, int):
        CAMERA_ANGLE_BY_ID[_aid] = _row


def angle_ui_label(angle_id: int) -> str:
    row = CAMERA_ANGLE_BY_ID.get(angle_id)
    if not row:
        return ""
    az = row.get("azimuth_descriptor") or ""
    el = row.get("elevation_descriptor") or ""
    dist = row.get("distance_descriptor") or ""
    parts = [p for p in (az, el, dist) if isinstance(p, str) and p.strip()]
    if parts:
        return " · ".join(parts)
    return ""


def grouped_angle_ids() -> list[tuple[str, list[int]]]:
    """
    Group angle ids by "{distance_descriptor} · {elevation_descriptor}".
    Within each group, sort by azimuth_deg then id.
    """
    buckets: dict[str, list[tuple[int, int]]] = {}
    for aid, row in sorted(CAMERA_ANGLE_BY_ID.items()):
        dist = row.get("distance_descriptor")
        elev = row.get("elevation_descriptor")
        if not isinstance(dist, str):
            dist = ""
        if not isinstance(elev, str):
            elev = ""
        key = f"{dist.strip()} · {elev.strip()}".strip(" ·") or "Angles"
        az_deg = row.get("azimuth_deg")
        az_i = int(az_deg) if isinstance(az_deg, (int, float)) else 0
        buckets.setdefault(key, []).append((az_i, aid))

    out: list[tuple[str, list[int]]] = []
    for key in sorted(buckets.keys()):
        pairs = sorted(buckets[key], key=lambda t: (t[0], t[1]))
        out.append((key, [p[1] for p in pairs]))
    return out


def _ensure_storage_root() -> None:
    DEFAULT_STORAGE_ROOT.mkdir(parents=True, exist_ok=True)


class AnimeGenServiceError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        prompt_id: str | None = None,
        prompt_index: int | None = None,
    ) -> None:
        super().__init__(message)
        self.prompt_id = prompt_id
        self.prompt_index = prompt_index


def generate_character_base(character_name: str, prompt: str) -> tuple[str, str]:
    """Returns (path to image for preview, base_path on disk)."""
    _ensure_storage_root()
    character = get_character_paths(character_name)
    ensure_dirs(character.base_dir)

    body = _run_service_testmode(
        "services.anime_img_gen_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--prompt",
            prompt,
        ],
    )
    if body.get("error"):
        raise AnimeGenServiceError(
            str(body["error"]),
            prompt_id=body.get("prompt_id") if isinstance(body.get("prompt_id"), str) else None,
            prompt_index=body.get("prompt_index") if isinstance(body.get("prompt_index"), int) else None,
        )

    url = _extract_image_url_from_anime_results(body)
    if os.path.isfile(url):
        src = Path(url)
        ext = src.suffix.lower() if src.suffix else ".png"
        dest = character.base_dir / f"base_img{ext}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        path_str = str(dest)
        return path_str, path_str
    ext = infer_ext_from_url(url)
    base_path = character.base_dir / f"base_img{ext}"
    download_url_to_file(url, base_path)
    path_str = str(base_path)
    return path_str, path_str


_BASE_DRAFT_STEM_RE = re.compile(r"^base(\d+)$", re.IGNORECASE)

_DRAFT_IMAGE_EXTS = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
)


def next_base_draft_index_in_dir(draft_dir: Path) -> int:
    """Next index for ``base{N}.*`` drafts under ``draft_dir``."""
    if not draft_dir.is_dir():
        return 0
    max_n = -1
    for p in draft_dir.iterdir():
        if not p.is_file():
            continue
        m = _BASE_DRAFT_STEM_RE.match(p.stem)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return max_n + 1


def list_base_draft_paths_in_dir(draft_dir: Path) -> list[str]:
    """Sorted absolute paths: ``base0.*``, ``base1.*``, … under ``draft_dir``."""
    if not draft_dir.is_dir():
        return []
    pairs: list[tuple[int, Path]] = []
    for p in draft_dir.iterdir():
        if not p.is_file() or p.suffix.lower() not in _DRAFT_IMAGE_EXTS:
            continue
        m = _BASE_DRAFT_STEM_RE.match(p.stem)
        if m:
            pairs.append((int(m.group(1)), p))
    pairs.sort(key=lambda t: t[0])
    return [str(p) for _i, p in pairs]


def list_new_character_draft_paths() -> list[str]:
    """Draft images in the shared ``temp`` workspace (React new-character page)."""
    return list_base_draft_paths_in_dir(new_character_draft_dir())


def clear_new_character_draft_workspace() -> None:
    """Remove every ``baseN.*`` under the new-character draft folder."""
    d = new_character_draft_dir()
    if not d.is_dir():
        return
    for p in d.iterdir():
        if not p.is_file():
            continue
        if _BASE_DRAFT_STEM_RE.match(p.stem):
            try:
                p.unlink()
            except OSError:
                pass


def delete_new_character_draft_file(selected_path: str | Path) -> None:
    """Delete one ``temp/baseN.*`` draft file."""
    sel = Path(selected_path).resolve()
    if not sel.is_file():
        raise ValueError("File not found.")
    draft_root = new_character_draft_dir().resolve()
    if sel.parent.resolve() != draft_root:
        raise ValueError("File must be in the new-character draft folder.")
    if not _BASE_DRAFT_STEM_RE.match(sel.stem):
        raise ValueError("Not a numbered base draft (base0, base1, …).")
    sel.unlink()


def archive_new_character_draft_file(selected_path: str | Path) -> str:
    """
    Copy ``temp/baseN.*`` into ``character_archive`` with a unique name, then remove from temp.
    Returns absolute path of the archived file.
    """
    sel = Path(selected_path).resolve()
    if not sel.is_file():
        raise ValueError("File not found.")
    draft_root = new_character_draft_dir().resolve()
    if sel.parent.resolve() != draft_root:
        raise ValueError("File must be in the new-character draft folder.")
    if not _BASE_DRAFT_STEM_RE.match(sel.stem):
        raise ValueError("Not a numbered base draft (base0, base1, …).")

    _ensure_storage_root()
    arc = character_archive_dir()
    ensure_dirs(arc)
    ext = sel.suffix.lower() if sel.suffix else ".png"
    dest = arc / f"base_{int(time.time() * 1000)}{ext}"
    dest.write_bytes(sel.read_bytes())
    sel.unlink()
    return str(dest)


def list_character_archive_paths() -> list[str]:
    """Sorted absolute paths of image files in ``character_archive``."""
    d = character_archive_dir()
    if not d.is_dir():
        return []
    out: list[str] = []
    for p in d.iterdir():
        if p.is_file() and p.suffix.lower() in _DRAFT_IMAGE_EXTS:
            out.append(str(p))
    out.sort(key=lambda s: Path(s).name.lower())
    return out


def import_character_archive_file_to_temp(source_path: str | Path) -> str:
    """Copy an archived image into ``temp`` as the next ``baseN.*``."""
    src = Path(source_path).resolve()
    if not src.is_file():
        raise ValueError("File not found.")
    arc_root = character_archive_dir().resolve()
    if src.parent.resolve() != arc_root:
        raise ValueError("File must be in character_archive.")
    if src.suffix.lower() not in _DRAFT_IMAGE_EXTS:
        raise ValueError("Unsupported image type.")

    _ensure_storage_root()
    draft_root = new_character_draft_dir()
    ensure_dirs(draft_root)
    idx = next_base_draft_index_in_dir(draft_root)
    ext = src.suffix if src.suffix else ".png"
    dest = draft_root / f"base{idx}{ext}"
    dest.write_bytes(src.read_bytes())
    return str(dest)


def archive_new_location_draft_file(selected_path: str | Path) -> str:
    """
    Copy a file from ``locations/_drafts`` into ``location_archive``, then remove the draft.
    Returns absolute path of the archived file.
    """
    sel = Path(selected_path).resolve()
    if not sel.is_file():
        raise ValueError("File not found.")
    draft_root = new_location_draft_dir().resolve()
    if sel.parent.resolve() != draft_root:
        raise ValueError("File must be in the new-location draft folder.")
    if sel.suffix.lower() not in _DRAFT_IMAGE_EXTS:
        raise ValueError("Unsupported image type.")

    ensure_dirs(LOCATION_STORAGE_ROOT)
    arc = location_archive_dir()
    ensure_dirs(arc)
    ext = sel.suffix.lower() if sel.suffix else ".png"
    dest = arc / f"loc_{int(time.time() * 1000)}{ext}"
    dest.write_bytes(sel.read_bytes())
    sel.unlink()
    return str(dest)


def list_location_archive_paths() -> list[str]:
    """Sorted absolute paths of image files in ``_location_archive``."""
    d = location_archive_dir()
    if not d.is_dir():
        return []
    out: list[str] = []
    for p in d.iterdir():
        if p.is_file() and p.suffix.lower() in _DRAFT_IMAGE_EXTS:
            out.append(str(p))
    out.sort(key=lambda s: Path(s).name.lower())
    return out


def import_location_archive_file_to_drafts(source_path: str | Path) -> str:
    """Copy an archived image into ``locations/_drafts`` as ``draft_<suffix>.*``."""
    src = Path(source_path).resolve()
    if not src.is_file():
        raise ValueError("File not found.")
    arc_root = location_archive_dir().resolve()
    if src.parent.resolve() != arc_root:
        raise ValueError("File must be in _location_archive.")
    if src.suffix.lower() not in _DRAFT_IMAGE_EXTS:
        raise ValueError("Unsupported image type.")

    ensure_dirs(LOCATION_STORAGE_ROOT)
    draft_root = new_location_draft_dir()
    ensure_dirs(draft_root)
    ext = src.suffix.lower() if src.suffix else ".png"
    dest = draft_root / f"draft_{unique_suffix(12)}{ext}"
    dest.write_bytes(src.read_bytes())
    return str(dest)


def delete_new_location_draft_file(selected_path: str | Path) -> None:
    """Delete one image file under ``locations/_drafts``."""
    sel = Path(selected_path).resolve()
    if not sel.is_file():
        raise ValueError("File not found.")
    draft_root = new_location_draft_dir().resolve()
    if sel.parent.resolve() != draft_root:
        raise ValueError("File must be in the new-location draft folder.")
    if sel.suffix.lower() not in _DRAFT_IMAGE_EXTS:
        raise ValueError("Unsupported image type.")
    sel.unlink()


def clear_new_location_draft_workspace() -> None:
    """Remove every image file under ``locations/_drafts``."""
    d = new_location_draft_dir()
    if not d.is_dir():
        return
    for p in d.iterdir():
        if not p.is_file() or p.suffix.lower() not in _DRAFT_IMAGE_EXTS:
            continue
        try:
            p.unlink()
        except OSError:
            pass


def generate_character_base_draft_to_temp(
    prompt: str,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> tuple[str, str]:
    """
    React new-character flow: append ``baseN`` under ``characters/temp``.
    Returns (path to image for preview, same path on disk).
    """
    _ensure_storage_root()
    draft_root = new_character_draft_dir()
    ensure_dirs(draft_root)

    full_prompt = compose_new_character_positive_prompt(prompt)
    if log_cb:
        snip = full_prompt.replace("\n", " ").replace("\r", "")
        if len(snip) > 200:
            snip = snip[:197] + "..."
        log_cb(f"new_character_base prompt (composed): {snip}")

    body = _run_service_testmode(
        "services.anime_img_gen_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--skip-default-style-prefix",
            "--prompt",
            full_prompt,
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise AnimeGenServiceError(
            str(body["error"]),
            prompt_id=body.get("prompt_id") if isinstance(body.get("prompt_id"), str) else None,
            prompt_index=body.get("prompt_index") if isinstance(body.get("prompt_index"), int) else None,
        )

    url = _extract_image_url_from_anime_results(body)
    idx = next_base_draft_index_in_dir(draft_root)
    if os.path.isfile(url):
        src = Path(url)
        ext = src.suffix.lower() if src.suffix else ".png"
        dest = draft_root / f"base{idx}{ext}"
        shutil.copy2(src, dest)
        path_str = str(dest)
        return path_str, path_str
    ext = infer_ext_from_url(url)
    dest = draft_root / f"base{idx}{ext}"
    download_url_to_file(url, dest)
    path_str = str(dest)
    return path_str, path_str


def save_uploaded_character_base(character_name: str, source_path: str | Path) -> str:
    src = Path(source_path)
    if not src.is_file():
        raise ValueError("Please choose a valid image file.")
    _ensure_storage_root()
    character = get_character_paths(character_name)
    ensure_dirs(character.base_dir)

    ext = src.suffix if src.suffix else ".png"
    dest = character.base_dir / f"base_img{ext}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())
    return str(dest)


def append_uploaded_character_draft_to_temp(source_path: str | Path) -> str:
    """Append upload as the next ``baseN.*`` under ``characters/temp``."""
    src = Path(source_path)
    if not src.is_file():
        raise ValueError("Please choose a valid image file.")
    _ensure_storage_root()
    draft_root = new_character_draft_dir()
    ensure_dirs(draft_root)
    idx = next_base_draft_index_in_dir(draft_root)
    ext = src.suffix if src.suffix else ".png"
    dest = draft_root / f"base{idx}{ext}"
    dest.write_bytes(src.read_bytes())
    return str(dest)


def finalize_new_character_from_temp(character_name: str, selected_path: str | Path) -> str:
    """
    Copy chosen ``temp/baseN.*`` into a new character folder as ``base_img.*``.

    The new-character draft folder is not cleared here so the user can abandon
    the closeup wizard and still have draft bases on the creation page; clear
    drafts after closeups complete (``apiNewCharacterDiscard``) or via Cancel.
    """
    sel = Path(selected_path).resolve()
    if not sel.is_file():
        raise ValueError("Selected image not found.")
    _ensure_storage_root()
    draft_root = new_character_draft_dir().resolve()
    if sel.parent.resolve() != draft_root:
        raise ValueError("Selected file must be in the new-character draft folder.")
    if not _BASE_DRAFT_STEM_RE.match(sel.stem):
        raise ValueError("Selected file must be a draft (base0, base1, …).")

    new_key = sanitize_for_folder(character_name)
    if not new_key or new_key == "unnamed":
        raise ValueError("Name is required.")
    if new_key == NEW_CHARACTER_DRAFT_DIRNAME:
        raise ValueError(f"The name {NEW_CHARACTER_DRAFT_DIRNAME!r} is reserved.")

    new_character = get_character_paths(new_key)
    new_dir = new_character.character_dir
    if new_dir.exists():
        try:
            if any(new_dir.iterdir()):
                raise ValueError(f"A character named {new_key!r} already exists.")
        except ValueError:
            raise
        except OSError as e:
            raise ValueError(f"A character named {new_key!r} already exists.") from e

    data = sel.read_bytes()
    ext = sel.suffix if sel.suffix else ".png"
    ensure_dirs(new_character.base_dir)
    _clear_root_cover_artifacts(new_character)
    dest = new_character.base_dir / f"base_img{ext}"
    dest.write_bytes(data)

    try:
        ensure_base_pose_in_gallery(new_key)
    except Exception:
        pass

    return str(dest)


def _clear_root_cover_artifacts(character) -> None:
    """Remove root cover artifacts so new renders are unambiguous."""
    d = character.base_dir
    if not d.is_dir():
        return
    for pattern in (
        "base.*",
        "base_img.*",
        "base_closeup.*",
        "base_combined.*",
        "base_closeup_front.*",
        "base_closeup_left.*",
        "base_closeup_right.*",
        "base_closeup_back.*",
    ):
        for p in d.glob(pattern):
            if p.is_file():
                p.unlink()


def set_character_cover_from_image(char_key: str, source_path: str | Path) -> str:
    """
    Replace the character hub/detail cover (``base.*`` in the character folder)
    by copying an existing image file (e.g. any pose/expression asset).
    """
    src = Path(source_path)
    if not src.is_file():
        raise ValueError("Please choose a valid image file.")

    # Read source bytes before clearing root artifacts.
    data = src.read_bytes()

    _ensure_storage_root()
    character = get_character_paths(char_key)
    ensure_dirs(character.base_dir)
    _clear_root_cover_artifacts(character)
    ext = src.suffix if src.suffix else ".png"
    dest = character.base_dir / f"base_img{ext}"
    dest.write_bytes(data)
    return str(dest)


def _stem_is_non_cover_gallery_artifact(p: Path) -> bool:
    """True for composite / closeup files that must not become ``base_img`` via cover reassignment."""
    s = p.stem.lower()
    if s == "base_combined":
        return True
    if s == "base_closeup" or s.startswith("base_closeup_"):
        return True
    return False


def reassign_character_cover_if_invalid(char_key: str) -> bool:
    """
    If hub cover ``base_img`` / ``base`` is missing on disk, copy the first deduped character image as the new cover.

    Returns True if a new cover file was written.
    """
    cur = character_base_image_path(char_key)
    if cur is not None:
        try:
            if Path(cur).is_file():
                return False
        except OSError:
            pass
    for abs_path in list_character_image_paths_deduped(char_key):
        p = Path(abs_path)
        if not p.is_file():
            continue
        if _stem_is_non_cover_gallery_artifact(p):
            continue
        try:
            set_character_cover_from_image(char_key, p)
            return True
        except ValueError:
            continue
    return False


_CLOSEUP_STEPS: list[tuple[str, int, str]] = [
    ("front", 8, "Front Angle"),
    ("left", 14, "Left Angle"),
    ("right", 10, "Right Angle"),
    ("back", 12, "Back Angle"),
]
_CLOSEUP_STEM_BY_STEP: dict[str, str] = {
    "front": "base_closeup_front",
    "left": "base_closeup_left",
    "right": "base_closeup_right",
    "back": "base_closeup_back",
}
_closeup_wizard_lock = threading.Lock()
_closeup_wizard_sessions: dict[str, dict[str, Any]] = {}


def closeup_wizard_steps() -> list[dict[str, Any]]:
    return [
        {"stepKey": key, "angleId": angle_id, "label": label}
        for key, angle_id, label in _CLOSEUP_STEPS
    ]


def _closeup_step_index(step_key: str) -> int:
    for i, (k, _aid, _label) in enumerate(_CLOSEUP_STEPS):
        if k == step_key:
            return i
    raise ValueError(f"Unknown closeup step: {step_key}")


def _closeup_unsaved_preview_paths(session: dict[str, Any]) -> dict[str, Path]:
    """Paths to last successful per-step temp outputs (exist on disk)."""
    raw = session.get("generatedAbsByStep") or {}
    out: dict[str, Path] = {}
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        p = Path(v)
        if p.is_file():
            out[k] = p
    return out


def _compose_closeup_quadrant_preview(
    char_key: str,
    saved: dict[str, str],
    failed: dict[str, str],
    seen: set[str],
    current_step_key: str | None,
    *,
    candidate_preview_abs: Path | None = None,
    candidate_preview_step: str | None = None,
    unsaved_generated_abs_by_step: dict[str, Path] | None = None,
) -> str:
    from PIL import Image, ImageDraw, ImageOps

    character = get_character_paths(char_key)
    size = 512
    quad_h = size * 2
    quad_w = size * 2
    base_w = 0
    base_left = None
    base_abs_s = character_base_source_image_path(char_key)
    if base_abs_s:
        base_p = Path(str(base_abs_s))
        if base_p.is_file():
            bi = Image.open(base_p).convert("RGB")
            bw_i, bh_i = bi.size
            if bh_i > 0:
                natural_w = max(1, round(bw_i * quad_h / bh_i))
                max_base_w = size * 6
                col_w = min(natural_w, max_base_w)
                base_left = ImageOps.fit(bi, (col_w, quad_h), method=Image.Resampling.LANCZOS)
                base_w = col_w

    canvas = Image.new("RGB", (base_w + quad_w, quad_h), (18, 18, 18))
    if base_left is not None:
        canvas.paste(base_left, (0, 0))
    draw = ImageDraw.Draw(canvas)
    ox = base_w
    slots = {
        "front": (0, 0),
        "left": (1, 0),
        "right": (0, 1),
        "back": (1, 1),
    }
    labels = {
        "front": "Front Angle",
        "left": "Left Angle",
        "right": "Right Angle",
        "back": "Back Angle",
    }
    for step, (cx, cy) in slots.items():
        rel = saved.get(step)
        if rel:
            src = resolve_storage_rel_path_to_abs(rel)
            if src.is_file():
                img = Image.open(src).convert("RGB")
                tile = ImageOps.fit(img, (size, size), method=Image.Resampling.LANCZOS)
                canvas.paste(tile, (ox + cx * size, cy * size))
                continue
            failed.setdefault(step, "missing_file")
            x0, y0 = ox + cx * size, cy * size
            draw.rectangle([x0, y0, x0 + size, y0 + size], fill=(20, 20, 20))
            draw.rectangle(
                [x0 + 2, y0 + 2, x0 + size - 2, y0 + size - 2],
                outline=(255, 255, 255),
                width=3,
            )
            txt = f"{labels.get(step, step)} - Failed"
            bb = draw.textbbox((0, 0), txt)
            tw, th = bb[2] - bb[0], bb[3] - bb[1]
            draw.text(
                (x0 + max(8, (size - tw) / 2), y0 + max(8, (size - th) / 2)),
                txt,
                fill=(255, 255, 255),
            )
            continue

        if (
            candidate_preview_step == step
            and candidate_preview_abs is not None
            and candidate_preview_abs.is_file()
        ):
            img = Image.open(candidate_preview_abs).convert("RGB")
            tile = ImageOps.fit(img, (size, size), method=Image.Resampling.LANCZOS)
            canvas.paste(tile, (ox + cx * size, cy * size))
            continue

        if unsaved_generated_abs_by_step:
            u = unsaved_generated_abs_by_step.get(step)
            if u is not None and u.is_file():
                img = Image.open(u).convert("RGB")
                tile = ImageOps.fit(img, (size, size), method=Image.Resampling.LANCZOS)
                canvas.paste(tile, (ox + cx * size, cy * size))
                continue

        x0, y0 = ox + cx * size, cy * size
        if step in failed:
            draw.rectangle([x0, y0, x0 + size, y0 + size], fill=(20, 20, 20))
            draw.rectangle(
                [x0 + 2, y0 + 2, x0 + size - 2, y0 + size - 2],
                outline=(255, 255, 255),
                width=3,
            )
            txt = f"{labels.get(step, step)} - Failed"
            bb = draw.textbbox((0, 0), txt)
            tw, th = bb[2] - bb[0], bb[3] - bb[1]
            draw.text(
                (x0 + max(8, (size - tw) / 2), y0 + max(8, (size - th) / 2)),
                txt,
                fill=(255, 255, 255),
            )
        elif step in seen:
            draw.rectangle([x0, y0, x0 + size, y0 + size], fill=(32, 32, 32))
            txt = f"{labels.get(step, step)} - Pending"
            bb = draw.textbbox((0, 0), txt)
            tw, th = bb[2] - bb[0], bb[3] - bb[1]
            draw.text(
                (x0 + max(8, (size - tw) / 2), y0 + max(8, (size - th) / 2)),
                txt,
                fill=(200, 200, 200),
            )
    out_name = f".closeup_preview_{current_step_key or 'all'}_{unique_suffix()}.png"
    out_abs = character.character_dir / out_name
    canvas.save(out_abs, format="PNG")
    return _abs_to_storage_rel(out_abs)


def _run_single_multi_angle_from_image(
    input_abs: Path, angle_id: int, log_cb: Callable[[str], None] | None = None
) -> Path:
    label = angle_ui_label(angle_id) or f"angle {angle_id}"
    if log_cb:
        log_cb(f"Generating {label} (id={angle_id})...")
    body = _run_service_testmode(
        "services.multi_angle_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            str(input_abs),
            "--angle-id",
            str(angle_id),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body.get("error")))
    url = _extract_single_result_url_from_multi_angle(body)
    ext = infer_ext_from_url(url)
    out_abs = Path(tempfile.gettempdir()) / f"closeup_{angle_id}_{unique_suffix()}{ext}"
    download_url_to_file(url, out_abs)
    return out_abs


def make_angle_to_temp_file(
    input_abs_path: str,
    angle_id: int,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Public wrapper: generate a single camera angle from an arbitrary image and
    return the path to a temp PNG. Used by net-new angle surfaces (shot composer
    layers, sequence frames) that stage the result themselves."""
    src = Path(input_abs_path)
    if not src.is_file():
        raise ValueError(f"Angle source image not found: {input_abs_path}")
    out_abs = _run_single_multi_angle_from_image(src, int(angle_id), log_cb=log_cb)
    return str(out_abs)


def start_closeup_wizard(char_key: str) -> dict[str, Any]:
    base_abs = character_base_source_image_path(char_key)
    if not base_abs:
        raise ValueError("No base image found for closeup generation.")
    session_id = f"cw_{unique_suffix(12)}"
    with _closeup_wizard_lock:
        _closeup_wizard_sessions[session_id] = {
            "charKey": char_key,
            "baseAbs": base_abs,
            "stepIndex": 0,
            "saved": {},
            "failed": {},
            "seen": [],
            "candidateAbs": None,
            "candidateStepKey": None,
            "tempFiles": [],
            "generatedAbsByStep": {},
        }
    return {
        "sessionId": session_id,
        "steps": closeup_wizard_steps(),
        "currentStepIndex": 0,
        "saved": {},
        "failed": {},
    }


def _closeup_session(session_id: str) -> dict[str, Any]:
    with _closeup_wizard_lock:
        s = _closeup_wizard_sessions.get(session_id)
    if not s:
        raise ValueError("Closeup wizard session not found.")
    return s


def _persist_closeup_candidate_to_session_saved(
    session: dict[str, Any], char_key: str, step_key: str, candidate_abs: Path
) -> str:
    """Copy generated closeup to character base_dir stem and record storage rel on session."""
    character = get_character_paths(char_key)
    ext = candidate_abs.suffix or ".png"
    dest = character.base_dir / f"{_CLOSEUP_STEM_BY_STEP[step_key]}{ext}"
    shutil.copy2(candidate_abs, dest)
    dest_rel = _abs_to_storage_rel(dest)
    saved = dict(session.get("saved") or {})
    saved[step_key] = dest_rel
    session["saved"] = saved
    failed = dict(session.get("failed") or {})
    failed.pop(step_key, None)
    session["failed"] = failed
    return dest_rel


def _closeup_multi_angle_source_abs(
    session: dict[str, Any],
    step_key: str,
    log_cb: Callable[[str], None] | None = None,
) -> Path:
    """Input image for multi-angle closeup: full body for front; persisted front closeup for other steps."""
    base = Path(str(session["baseAbs"]))
    if step_key == "front":
        return base
    rel = (session.get("saved") or {}).get("front")
    if isinstance(rel, str) and rel.strip():
        rel_norm = rel.replace("\\", "/").lstrip("/")
        front_abs = (DEFAULT_STORAGE_ROOT / rel_norm).resolve()
        if front_abs.is_file():
            return front_abs
    if log_cb:
        log_cb(
            "Closeup: no saved front closeup on disk for this session; "
            "using full-body base for multi-angle input."
        )
    return base


def generate_current_closeup_wizard(
    session_id: str, *, force: bool, log_cb: Callable[[str], None] | None = None
) -> dict[str, Any]:
    session = _closeup_session(session_id)
    idx = int(session.get("stepIndex") or 0)
    step_key, angle_id, label = _CLOSEUP_STEPS[idx]
    failed = dict(session.get("failed") or {})
    seen = set(str(x) for x in (session.get("seen") or []))
    seen.add(step_key)
    session["seen"] = sorted(seen)
    failure_error: str | None = None
    candidate_rel: str | None = None
    if not force and session.get("candidateAbs") and session.get("candidateStepKey") == step_key:
        candidate_abs = Path(str(session["candidateAbs"]))
    else:
        try:
            source_abs = _closeup_multi_angle_source_abs(session, step_key, log_cb=log_cb)
            candidate_abs = _run_single_multi_angle_from_image(
                source_abs, angle_id, log_cb=log_cb
            )
            session["candidateAbs"] = str(candidate_abs)
            session["candidateStepKey"] = step_key
            temp_files = list(session.get("tempFiles") or [])
            temp_files.append(str(candidate_abs))
            session["tempFiles"] = temp_files
            failed.pop(step_key, None)
            session["failed"] = failed
        except Exception as e:
            failure_error = str(e)
            failed[step_key] = failure_error or "generation_failed"
            session["failed"] = failed
            session["candidateAbs"] = None
            session["candidateStepKey"] = None
            candidate_abs = None
            gen_pop = dict(session.get("generatedAbsByStep") or {})
            gen_pop.pop(step_key, None)
            session["generatedAbsByStep"] = gen_pop
    char_key = str(session["charKey"])
    if candidate_abs and candidate_abs.is_file():
        candidate_rel = _persist_closeup_candidate_to_session_saved(
            session, char_key, step_key, candidate_abs
        )
        gen_after = dict(session.get("generatedAbsByStep") or {})
        gen_after.pop(step_key, None)
        session["generatedAbsByStep"] = gen_after
    saved = dict(session.get("saved") or {})
    preview_rel = _compose_closeup_quadrant_preview(
        char_key,
        saved,
        failed,
        seen,
        step_key,
        unsaved_generated_abs_by_step=_closeup_unsaved_preview_paths(session),
    )
    if saved:
        _flush_closeup_composites_from_session_saved(char_key, saved)
    return {
        "stepKey": step_key,
        "stepLabel": label,
        "stepIndex": idx,
        "currentStepIndex": idx,
        "candidateRelPath": candidate_rel,
        "compositePreviewRelPath": preview_rel,
        "saved": dict(session.get("saved") or {}),
        "failed": dict(session.get("failed") or {}),
        "error": failure_error,
    }


def save_current_closeup_and_advance(
    session_id: str, log_cb: Callable[[str], None] | None = None
) -> dict[str, Any]:
    session = _closeup_session(session_id)
    idx = int(session.get("stepIndex") or 0)
    step_key, _angle_id, _label = _CLOSEUP_STEPS[idx]
    candidate_abs_s = session.get("candidateAbs")
    if not candidate_abs_s:
        raise ValueError("No generated candidate to save.")
    candidate_abs = Path(str(candidate_abs_s))
    if not candidate_abs.is_file():
        raise ValueError("Candidate image missing on disk.")
    char_key = str(session["charKey"])
    _persist_closeup_candidate_to_session_saved(session, char_key, step_key, candidate_abs)
    saved = dict(session.get("saved") or {})
    if saved:
        _flush_closeup_composites_from_session_saved(char_key, saved)
    gen_saved = dict(session.get("generatedAbsByStep") or {})
    gen_saved.pop(step_key, None)
    session["generatedAbsByStep"] = gen_saved
    failed = dict(session.get("failed") or {})
    next_idx = min(idx + 1, len(_CLOSEUP_STEPS) - 1)
    session["stepIndex"] = next_idx
    session["candidateAbs"] = None
    session["candidateStepKey"] = None
    if idx >= len(_CLOSEUP_STEPS) - 1:
        return {
            "done": True,
            "currentStepIndex": idx,
            "saved": saved,
            "failed": failed,
            "steps": closeup_wizard_steps(),
        }
    generated = generate_current_closeup_wizard(session_id, force=True, log_cb=log_cb)
    if log_cb:
        _nkey, _naid, nlabel = _CLOSEUP_STEPS[next_idx]
        log_cb(f"Generating next angle: {nlabel}...")
    return {
        "done": False,
        "currentStepIndex": next_idx,
        "saved": saved,
        "failed": failed,
        "steps": closeup_wizard_steps(),
        "next": generated,
    }


def save_current_closeup_only(session_id: str) -> dict[str, Any]:
    session = _closeup_session(session_id)
    idx = int(session.get("stepIndex") or 0)
    step_key, _angle_id, label = _CLOSEUP_STEPS[idx]
    candidate_abs_s = session.get("candidateAbs")
    if not candidate_abs_s:
        raise ValueError("No generated candidate to save.")
    candidate_abs = Path(str(candidate_abs_s))
    if not candidate_abs.is_file():
        raise ValueError("Candidate image missing on disk.")
    char_key = str(session["charKey"])
    _persist_closeup_candidate_to_session_saved(session, char_key, step_key, candidate_abs)
    saved = dict(session.get("saved") or {})
    gen_only = dict(session.get("generatedAbsByStep") or {})
    gen_only.pop(step_key, None)
    session["generatedAbsByStep"] = gen_only
    failed = dict(session.get("failed") or {})

    seen = set(str(x) for x in (session.get("seen") or []))
    seen.add(step_key)
    session["seen"] = sorted(seen)
    preview_rel = _compose_closeup_quadrant_preview(
        char_key,
        saved,
        failed,
        seen,
        step_key,
        unsaved_generated_abs_by_step=_closeup_unsaved_preview_paths(session),
    )
    if saved:
        _flush_closeup_composites_from_session_saved(char_key, saved)
    return {
        "stepKey": step_key,
        "stepLabel": label,
        "currentStepIndex": idx,
        "saved": saved,
        "failed": failed,
        "compositePreviewRelPath": preview_rel,
        "steps": closeup_wizard_steps(),
    }


def go_last_closeup_wizard(session_id: str) -> dict[str, Any]:
    session = _closeup_session(session_id)
    idx = int(session.get("stepIndex") or 0)
    idx = max(0, idx - 1)
    session["stepIndex"] = idx
    session["candidateAbs"] = None
    session["candidateStepKey"] = None
    step_key, _aid, label = _CLOSEUP_STEPS[idx]
    saved = dict(session.get("saved") or {})
    failed = dict(session.get("failed") or {})
    seen = set(str(x) for x in (session.get("seen") or []))
    saved_for_preview = dict(saved)
    preview_rel = _compose_closeup_quadrant_preview(
        str(session["charKey"]),
        saved_for_preview,
        failed,
        seen,
        step_key,
        unsaved_generated_abs_by_step=_closeup_unsaved_preview_paths(session),
    )
    return {
        "currentStepIndex": idx,
        "stepKey": step_key,
        "stepLabel": label,
        "saved": saved,
        "failed": failed,
        "compositePreviewRelPath": preview_rel,
    }


def go_next_closeup_wizard(session_id: str) -> dict[str, Any]:
    session = _closeup_session(session_id)
    idx = int(session.get("stepIndex") or 0)
    idx = min(len(_CLOSEUP_STEPS) - 1, idx + 1)
    session["stepIndex"] = idx
    session["candidateAbs"] = None
    session["candidateStepKey"] = None
    step_key, _aid, label = _CLOSEUP_STEPS[idx]
    saved = dict(session.get("saved") or {})
    failed = dict(session.get("failed") or {})
    seen = set(str(x) for x in (session.get("seen") or []))
    preview_rel = _compose_closeup_quadrant_preview(
        str(session["charKey"]),
        saved,
        failed,
        seen,
        step_key,
        unsaved_generated_abs_by_step=_closeup_unsaved_preview_paths(session),
    )
    return {
        "currentStepIndex": idx,
        "stepKey": step_key,
        "stepLabel": label,
        "saved": saved,
        "failed": failed,
        "compositePreviewRelPath": preview_rel,
    }


_CLOSEUP_QUADRANT_SLOTS: dict[str, tuple[int, int]] = {
    "front": (0, 0),
    "left": (1, 0),
    "right": (0, 1),
    "back": (1, 1),
}
_CLOSEUP_COMPOSITE_TILE_SIZE = 768
_CLOSEUP_COMPOSITE_BG_RGB = (18, 18, 18)


def _build_closeup_quadrant_image(saved: dict[str, str], *, allow_partial: bool) -> Any:
    from PIL import Image, ImageOps

    size = _CLOSEUP_COMPOSITE_TILE_SIZE
    quadrant = Image.new("RGB", (size * 2, size * 2), _CLOSEUP_COMPOSITE_BG_RGB)
    blank_tile = Image.new("RGB", (size, size), _CLOSEUP_COMPOSITE_BG_RGB)
    for step, (cx, cy) in _CLOSEUP_QUADRANT_SLOTS.items():
        rel = saved.get(step)
        if not rel:
            if allow_partial:
                quadrant.paste(blank_tile, (cx * size, cy * size))
                continue
            raise ValueError(f"Missing saved step: {step}")
        src = resolve_storage_rel_path_to_abs(rel)
        if not src.is_file():
            if allow_partial:
                quadrant.paste(blank_tile, (cx * size, cy * size))
                continue
            raise ValueError(f"Missing saved image file for {step}")
        img = Image.open(src).convert("RGB")
        tile = ImageOps.fit(img, (size, size), method=Image.Resampling.LANCZOS)
        quadrant.paste(tile, (cx * size, cy * size))
    return quadrant


def _write_closeup_and_combined(
    char_key: str,
    saved: dict[str, str],
    *,
    allow_partial: bool = False,
) -> tuple[str | None, str | None]:
    from PIL import Image, ImageOps

    if not saved:
        return None, None

    character = get_character_paths(char_key)
    size = _CLOSEUP_COMPOSITE_TILE_SIZE
    quadrant = _build_closeup_quadrant_image(saved, allow_partial=allow_partial)
    closeup_abs = character.base_dir / "base_closeup.png"
    quadrant.save(closeup_abs, format="PNG")

    base_src_abs_s = character_base_source_image_path(char_key)
    if not base_src_abs_s:
        raise ValueError("Base image missing.")
    base_src = Path(base_src_abs_s)
    base_img = Image.open(base_src).convert("RGB")
    base_square = ImageOps.fit(base_img, (size * 2, size * 2), method=Image.Resampling.LANCZOS)
    combined = Image.new("RGB", (size * 4, size * 2), _CLOSEUP_COMPOSITE_BG_RGB)
    combined.paste(base_square, (0, 0))
    combined.paste(quadrant, (size * 2, 0))
    combined_abs = character.base_dir / "base_combined.png"
    combined.save(combined_abs, format="PNG")
    return _abs_to_storage_rel(closeup_abs), _abs_to_storage_rel(combined_abs)


def _flush_closeup_composites_from_session_saved(
    char_key: str, saved: dict[str, str]
) -> tuple[str | None, str | None]:
    if not saved:
        return None, None
    return _write_closeup_and_combined(char_key, saved, allow_partial=True)


def _seed_closeup_views_to_expression_gallery(char_key: str) -> None:
    """Copy the four saved closeup angle images into ``expressions/expr_000``–``expr_003``.

    ``expr_000`` is the front closeup. Invoked after ``save_all_closeup_wizard`` writes
    ``base_closeup_*.`` Regenerate Closeup overwrites these four stems; ``expr_004+`` is left
    untouched.
    """
    character = get_character_paths(char_key)
    ensure_dirs(character.expressions_dir)
    step_index: list[tuple[str, int]] = [
        ("front", 0),
        ("left", 1),
        ("right", 2),
        ("back", 3),
    ]
    dest_paths: list[Path] = []
    for step_key, idx in step_index:
        stem = _CLOSEUP_STEM_BY_STEP[step_key]
        src = _find_first_matching_image(character.base_dir, stem)
        if not src or not src.is_file():
            raise ValueError(f"Missing closeup image for step {step_key} (stem {stem})")
        ext = src.suffix or ".png"
        dest = character.expressions_dir / f"expr_{idx:03d}{ext}"
        shutil.copy2(src, dest)
        dest_paths.append(dest)

    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    order = _sync_expression_image_order_with_disk(char_key, st)
    new_ids = [
        expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, _abs_to_storage_rel(p))
        for p in dest_paths
    ]
    new_set = set(new_ids)
    order = [iid for iid in order if iid not in new_set]
    hid = set(st.get(HIDDEN_EXPR_IMAGES) or [])
    for iid in new_ids:
        hid.discard(iid)
    st[EXPR_IMAGE_ORDER] = new_ids + order
    st[HIDDEN_EXPR_IMAGES] = sorted(hid)
    write_gallery_ui_state(char_key, st)


def save_all_closeup_wizard(session_id: str) -> dict[str, Any]:
    session = _closeup_session(session_id)
    saved = dict(session.get("saved") or {})
    char_key = str(session["charKey"])
    closeup_rel, combined_rel = _write_closeup_and_combined(
        char_key, saved, allow_partial=False
    )
    if not closeup_rel or not combined_rel:
        raise ValueError("All four closeup angles must be saved before finalize.")
    _seed_closeup_views_to_expression_gallery(char_key)
    return {
        "closeupRelPath": closeup_rel,
        "combinedRelPath": combined_rel,
        "saved": saved,
        "failed": dict(session.get("failed") or {}),
    }


def close_closeup_wizard(session_id: str) -> None:
    with _closeup_wizard_lock:
        s = _closeup_wizard_sessions.pop(session_id, None)
    if not s:
        return
    saved = dict(s.get("saved") or {})
    if saved:
        _flush_closeup_composites_from_session_saved(str(s["charKey"]), saved)
    for p in (s.get("tempFiles") or []):
        try:
            Path(str(p)).unlink(missing_ok=True)
        except Exception:
            pass


def delete_character_folder(char_key: str) -> None:
    """Remove the entire on-disk character directory."""
    _ensure_storage_root()
    character = get_character_paths(char_key)
    root = character.character_dir
    if not root.is_dir():
        raise ValueError("Character folder not found.")
    shutil.rmtree(root)


def _walk_sequence_manifest_rel_paths(
    data: dict[str, Any], apply_fn: Callable[[str], str]
) -> int:
    """Apply ``apply_fn(rel) -> rel'`` to every ``relPath`` inside a sequence manifest.

    Covers ``gallery[].relPath``, ``frames[].relPath``, plus nested
    ``gallery[].frameSequence.strip[].relPath`` and ``...frameSequence.hidden[].relPath``.
    Returns the number of entries where ``apply_fn`` produced a different value.
    Mutates ``data`` in place.
    """
    changed = 0

    def _apply(obj: dict[str, Any]) -> None:
        nonlocal changed
        v = obj.get("relPath")
        if isinstance(v, str) and v:
            nv = apply_fn(v)
            if nv != v:
                obj["relPath"] = nv
                changed += 1

    for coll in ("gallery", "frames"):
        for item in data.get(coll) or []:
            if not isinstance(item, dict):
                continue
            _apply(item)
            fs = item.get("frameSequence")
            if isinstance(fs, dict):
                strip = fs.get("strip")
                if isinstance(strip, list):
                    for slot in strip:
                        if isinstance(slot, dict):
                            _apply(slot)
                hidden = fs.get("hidden")
                if isinstance(hidden, list):
                    for h in hidden:
                        if isinstance(h, dict):
                            _apply(h)
    return changed


def _walk_sequence_manifest_crops(
    data: dict[str, Any], apply_fn: Callable[[dict[str, Any]], bool]
) -> int:
    """Apply ``apply_fn(crop_dict) -> changed?`` to every ``crop`` dict in a sequence manifest.

    Mirrors ``_walk_sequence_manifest_rel_paths`` coverage: ``gallery[].crop``,
    ``frames[].crop``, plus nested ``frameSequence.strip[].crop`` and ``...hidden[].crop``.
    Returns the number of crops where ``apply_fn`` reported a change. Mutates in place.
    """
    changed = 0

    def _apply(obj: dict[str, Any]) -> None:
        nonlocal changed
        c = obj.get("crop")
        if isinstance(c, dict) and apply_fn(c):
            changed += 1

    for coll in ("gallery", "frames"):
        for item in data.get(coll) or []:
            if not isinstance(item, dict):
                continue
            _apply(item)
            fs = item.get("frameSequence")
            if isinstance(fs, dict):
                strip = fs.get("strip")
                if isinstance(strip, list):
                    for slot in strip:
                        if isinstance(slot, dict):
                            _apply(slot)
                hidden = fs.get("hidden")
                if isinstance(hidden, list):
                    for h in hidden:
                        if isinstance(h, dict):
                            _apply(h)
    return changed


def _rewrite_char_prefix_in_sequence_manifest(
    data: dict[str, Any], old_key: str, new_key: str
) -> int:
    """Rewrite any ``relPath`` in a sequence manifest whose first segment is ``old_key``.

    Returns the number of entries changed. Mutates ``data`` in place.
    """
    old_prefix = f"{old_key}/"
    new_prefix = f"{new_key}/"

    def _rewrite(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(old_prefix):
            return new_prefix + r[len(old_prefix) :]
        return rel

    return _walk_sequence_manifest_rel_paths(data, _rewrite)


def _rewrite_flat_gallery_id_prefix(
    ids: list[Any], old_key: str, new_key: str
) -> tuple[list[Any], int]:
    """Return ``(new_ids, changed)`` rewriting ``pimg:`` / ``eimg:`` rel prefixes."""
    old_prefix = f"{old_key}/"
    new_prefix = f"{new_key}/"
    out: list[Any] = []
    changed = 0
    for iid in ids:
        if not isinstance(iid, str):
            out.append(iid)
            continue
        parsed: tuple[str, str] | None = None
        builder: Callable[[str, str], str] | None = None
        p = parse_pose_flat_gallery_item_id(iid)
        if p is not None:
            parsed = p
            builder = pose_flat_gallery_item_id
        else:
            e = parse_expr_flat_gallery_item_id(iid)
            if e is not None:
                parsed = e
                builder = expr_flat_gallery_item_id
        if parsed is None or builder is None:
            out.append(iid)
            continue
        bucket, rel = parsed
        rel_norm = rel.replace("\\", "/").lstrip("/")
        if rel_norm.startswith(old_prefix):
            out.append(builder(bucket, new_prefix + rel_norm[len(old_prefix) :]))
            changed += 1
        else:
            out.append(iid)
    return out, changed


_GALLERY_UI_STATE_FLAT_ID_FIELDS = (
    "pose_image_order",
    "hidden_pose_images",
    "expression_image_order",
    "hidden_expression_images",
    "dataset_builder_order",
    "dataset_builder_pose_strip_ids",
    "dataset_builder_expr_strip_ids",
)


def _rewrite_char_key_in_stored_paths(
    char_key_for_paths: str, old_key: str, new_key: str
) -> dict[str, int]:
    """
    Sweep all JSON files under the character at ``char_key_for_paths`` and rewrite
    any ``relPath`` / flat gallery id whose first path segment is ``old_key`` to use
    ``new_key`` instead. ``char_key_for_paths`` is the folder name currently on disk
    (typically ``new_key`` after a successful rename, or the current folder for repair).

    Returns a summary ``{"gallery": N, "sequences": N, "pose_refs": N, "total": N}``.
    """
    summary = {"gallery": 0, "sequences": 0, "pose_refs": 0, "total": 0}
    if not old_key or not new_key or old_key == new_key:
        return summary

    character = get_character_paths(char_key_for_paths)

    gallery_state_path = _gallery_ui_state_path(char_key_for_paths)
    if gallery_state_path.is_file():
        try:
            with open(gallery_state_path, encoding="utf-8") as f:
                raw_state = json.load(f)
        except Exception:
            raw_state = None
        if isinstance(raw_state, dict):
            gallery_changed = 0
            for field in _GALLERY_UI_STATE_FLAT_ID_FIELDS:
                lst = raw_state.get(field)
                if not isinstance(lst, list):
                    continue
                new_list, changed = _rewrite_flat_gallery_id_prefix(
                    lst, old_key, new_key
                )
                if changed:
                    raw_state[field] = new_list
                    gallery_changed += changed
            if gallery_changed:
                with open(gallery_state_path, "w", encoding="utf-8") as f:
                    json.dump(raw_state, f, indent=2)
                summary["gallery"] = gallery_changed

    sequences_dir = character.sequences_dir
    if sequences_dir.is_dir():
        for seq_folder in sequences_dir.iterdir():
            if not seq_folder.is_dir():
                continue
            man_path = seq_folder / SEQUENCE_MANIFEST_NAME
            if not man_path.is_file():
                continue
            try:
                with open(man_path, encoding="utf-8") as f:
                    man_data = json.load(f)
            except Exception:
                continue
            if not isinstance(man_data, dict):
                continue
            changed = _rewrite_char_prefix_in_sequence_manifest(
                man_data, old_key, new_key
            )
            if changed:
                with open(man_path, "w", encoding="utf-8") as f:
                    json.dump(man_data, f, indent=2)
                summary["sequences"] += changed

    refs_path = _pose_refs_manifest_path(char_key_for_paths)
    if refs_path.is_file():
        try:
            with open(refs_path, encoding="utf-8") as f:
                refs_data = json.load(f)
        except Exception:
            refs_data = None
        if isinstance(refs_data, list):
            old_prefix = f"{old_key}/"
            new_prefix = f"{new_key}/"
            refs_changed = 0
            for entry in refs_data:
                if not isinstance(entry, dict):
                    continue
                for key in ("referenceRelPath", "keypointRelPath"):
                    v = entry.get(key)
                    if isinstance(v, str) and v:
                        r = v.replace("\\", "/").lstrip("/")
                        if r.startswith(old_prefix):
                            entry[key] = new_prefix + r[len(old_prefix) :]
                            refs_changed += 1
            if refs_changed:
                with open(refs_path, "w", encoding="utf-8") as f:
                    json.dump(refs_data, f, indent=2)
                summary["pose_refs"] = refs_changed

    summary["total"] = summary["gallery"] + summary["sequences"] + summary["pose_refs"]
    return summary


def _scan_stale_char_key_prefixes(char_key: str) -> set[str]:
    """Collect first path segments inside stored JSON under ``char_key`` that differ from ``char_key``."""
    stale: set[str] = set()
    character = get_character_paths(char_key)

    gallery_state_path = _gallery_ui_state_path(char_key)
    if gallery_state_path.is_file():
        try:
            with open(gallery_state_path, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:
            state = None
        if isinstance(state, dict):
            for field in _GALLERY_UI_STATE_FLAT_ID_FIELDS:
                lst = state.get(field)
                if not isinstance(lst, list):
                    continue
                for iid in lst:
                    if not isinstance(iid, str):
                        continue
                    parsed = parse_pose_flat_gallery_item_id(
                        iid
                    ) or parse_expr_flat_gallery_item_id(iid)
                    if parsed is None:
                        continue
                    _bucket, rel = parsed
                    rel_norm = rel.replace("\\", "/").lstrip("/")
                    first = rel_norm.split("/", 1)[0]
                    if first and first != char_key:
                        stale.add(first)

    sequences_dir = character.sequences_dir
    if sequences_dir.is_dir():
        for seq_folder in sequences_dir.iterdir():
            if not seq_folder.is_dir():
                continue
            man_path = seq_folder / SEQUENCE_MANIFEST_NAME
            if not man_path.is_file():
                continue
            try:
                with open(man_path, encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:
                continue
            if not isinstance(data, dict):
                continue

            def _collect(rel: str) -> str:
                r = rel.replace("\\", "/").lstrip("/")
                first = r.split("/", 1)[0]
                if first and first != char_key:
                    stale.add(first)
                return rel

            _walk_sequence_manifest_rel_paths(data, _collect)

    refs_path = _pose_refs_manifest_path(char_key)
    if refs_path.is_file():
        try:
            with open(refs_path, encoding="utf-8") as f:
                refs = json.load(f)
        except Exception:
            refs = None
        if isinstance(refs, list):
            for entry in refs:
                if not isinstance(entry, dict):
                    continue
                for key in ("referenceRelPath", "keypointRelPath"):
                    v = entry.get(key)
                    if isinstance(v, str) and v:
                        r = v.replace("\\", "/").lstrip("/")
                        first = r.split("/", 1)[0]
                        if first and first != char_key:
                            stale.add(first)

    return stale


def repair_character_stored_paths(
    char_key: str, known_old_keys: list[str] | None = None
) -> dict[str, Any]:
    """
    Rewrite every ``relPath`` / flat gallery id under ``char_key`` whose first segment
    is not ``char_key`` so it points at the current folder name instead.

    When ``known_old_keys`` is provided, only those prefixes are rewritten. Returns a
    summary of what was changed: ``{"charKey": ..., "rewrote": {old: summary}, "totals": {...}}``.
    """
    character = get_character_paths(char_key)
    if not character.character_dir.is_dir():
        raise ValueError("Character folder not found.")
    detected = _scan_stale_char_key_prefixes(char_key)
    if known_old_keys is not None:
        detected &= set(known_old_keys)
    rewrote: dict[str, dict[str, int]] = {}
    totals = {"gallery": 0, "sequences": 0, "pose_refs": 0, "total": 0}
    for old in sorted(detected):
        s = _rewrite_char_key_in_stored_paths(char_key, old, char_key)
        rewrote[old] = s
        for k in totals:
            totals[k] += s.get(k, 0)
    return {"charKey": char_key, "rewrote": rewrote, "totals": totals}


def rename_character_folder(char_key: str, new_name: str) -> str:
    """
    Rename the character folder. Returns the new sanitized character key.

    Also rewrites every stored path/id under the renamed character so that the
    old character key prefix becomes the new one (sequence manifests,
    ``gallery_ui_state.json`` flat ids, and ``.pose_references/refs.json``).
    """
    _ensure_storage_root()
    character = get_character_paths(char_key)
    old_dir = character.character_dir
    if not old_dir.is_dir():
        raise ValueError("Character folder not found.")
    new_key = sanitize_for_folder(new_name)
    if not new_key or new_key == "unnamed":
        raise ValueError("Name is required.")
    new_character = get_character_paths(new_key)
    new_dir = new_character.character_dir
    if new_key == character.character_key:
        return new_key
    if new_dir.exists():
        try:
            clash = new_dir.resolve() != old_dir.resolve()
        except OSError:
            clash = True
        if clash:
            raise ValueError(f"A character named {new_key!r} already exists.")
    _rename_dir_case_safe(old_dir, new_dir)
    _rewrite_char_key_in_stored_paths(new_key, character.character_key, new_key)
    return new_key


def _append_pose_gallery_file_to_order(character_name: str, dest: Path) -> str:
    ensure_gallery_flat_migrated(character_name)
    iid = pose_flat_gallery_item_id(POSE_FLAT_BUCKET, _abs_to_storage_rel(dest))
    append_pose_image_ids_to_order(character_name, [iid])
    return _abs_to_storage_rel(dest)


def _download_url_to_pose_gallery(
    character_name: str, url: str, stem_tag: str
) -> tuple[str, str]:
    _ = stem_tag
    character = get_character_paths(character_name)
    ensure_dirs(character.poses_dir)
    ext = infer_ext_from_url(url)
    pid = _next_pose_tile_index_for_new_tile(character.poses_dir)
    dest = character.poses_dir / f"pose_{pid:03d}{ext}"
    download_url_to_file(url, dest)
    rel = _append_pose_gallery_file_to_order(character_name, dest)
    return str(dest), rel


def _append_expr_gallery_file_to_order(character_name: str, dest: Path) -> str:
    ensure_gallery_flat_migrated(character_name)
    iid = expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, _abs_to_storage_rel(dest))
    append_expression_image_ids_to_order(character_name, [iid])
    return _abs_to_storage_rel(dest)


def _download_url_to_expression_gallery(
    character_name: str, url: str, stem_tag: str
) -> tuple[str, str]:
    _ = stem_tag
    character = get_character_paths(character_name)
    ensure_dirs(character.expressions_dir)
    ext = infer_ext_from_url(url)
    eid = _next_expr_tile_index_for_new_tile(character.expressions_dir)
    dest = character.expressions_dir / f"expr_{eid:03d}{ext}"
    download_url_to_file(url, dest)
    rel = _append_expr_gallery_file_to_order(character_name, dest)
    return str(dest), rel


def character_base_closeup_composite_abs_path(char_key: str) -> str | None:
    """Absolute path to ``base_closeup.*`` (2x2 quadrant composite) if it exists on disk."""
    character = get_character_paths(char_key)
    p = _find_first_matching_image(character.base_dir, "base_closeup")
    if not p or not p.is_file():
        return None
    return str(p.resolve())


def _image_edit_aux_keypoint_cli_args(
    character_name: str,
    keypoint_image_path: str | None,
) -> list[str]:
    """Optional ``--auxiliary-image-urls-json``: ``[closeup_composite, keypoint]`` or ``[keypoint]`` only."""
    kp = (keypoint_image_path or "").strip()
    if not kp:
        return []
    urls: list[str] = []
    close_abs = character_base_closeup_composite_abs_path(character_name)
    if close_abs:
        urls.append(close_abs)
    urls.append(kp)
    return ["--auxiliary-image-urls-json", json.dumps(urls)]


def generate_pose_starting_image(
    character_name: str,
    pose_catalog_id: int,
    base_image_path: str | None,
    *,
    keypoint_image_path: str | None = None,
) -> tuple[str, str]:
    if base_image_path is None:
        raise ValueError("Base image is missing; create/save a character first.")
    if pose_catalog_id not in POSE_BY_ID:
        raise ValueError(f"Unknown pose id: {pose_catalog_id}")

    pose_opt = POSE_BY_ID[pose_catalog_id]
    indices_json = json.dumps([pose_opt.catalog_index])
    kp = (keypoint_image_path or "").strip()
    close_abs = character_base_closeup_composite_abs_path(character_name) if kp else None

    if kp and close_abs:
        prompt_inline = _append_closeup_keypoint_pose_hint(pose_opt.prompt_text)
        argv = [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps([prompt_inline]),
            *_image_edit_aux_keypoint_cli_args(character_name, keypoint_image_path),
            "--convert-local-to-url",
        ]
    elif kp:
        prompt_inline = _append_keypoint_only_pose_hint(pose_opt.prompt_text)
        argv = [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps([prompt_inline]),
            *_image_edit_aux_keypoint_cli_args(character_name, keypoint_image_path),
            "--convert-local-to-url",
        ]
    else:
        argv = [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "pose",
            "--indices-json",
            indices_json,
            *_image_edit_aux_keypoint_cli_args(character_name, keypoint_image_path),
            "--convert-local-to-url",
        ]

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        argv,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    urls = _extract_image_urls_from_image_edit(body)
    if not urls:
        raise RuntimeError("Image-edit returned no pose urls.")

    url = urls[0]
    label = POSE_BY_ID.get(body["results"][0].get("catalog_id"), pose_opt).label
    stem = sanitize_for_folder(label)
    abs_path, rel = _download_url_to_pose_gallery(character_name, url, stem)
    return abs_path, rel


def generate_pose_starting_image_from_prompt(
    character_name: str,
    pose_catalog_id: int,
    base_image_path: str | None,
    prompt_text_override: str | None,
    log_cb: Callable[[str], None] | None = None,
    *,
    keypoint_image_path: str | None = None,
) -> tuple[str, str]:
    """
    Generate a pose starting image using `prompt_source=inline` so the typed prompt can override
    the catalog prompt for the selected pose id.
    """
    if base_image_path is None:
        raise ValueError("Base image is missing; create/save a character first.")
    if pose_catalog_id not in POSE_BY_ID:
        raise ValueError(f"Unknown pose id: {pose_catalog_id}")

    pose_opt = POSE_BY_ID[pose_catalog_id]

    effective = (prompt_text_override or "").strip()
    if not effective:
        effective = pose_opt.prompt_text
    kp = (keypoint_image_path or "").strip()
    if kp and character_base_closeup_composite_abs_path(character_name):
        effective = _append_closeup_keypoint_pose_hint(effective)
    elif kp:
        effective = _append_keypoint_only_pose_hint(effective)

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps([effective]),
            *_image_edit_aux_keypoint_cli_args(character_name, keypoint_image_path),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    urls = _extract_image_urls_from_image_edit(body)
    if not urls:
        raise RuntimeError("Image-edit returned no pose urls.")

    url = urls[0]
    stem = sanitize_for_folder(pose_opt.label)
    abs_path, rel = _download_url_to_pose_gallery(character_name, url, stem)
    return abs_path, rel


# Prompt formatting helpers (build_expression_prompt_from_label / build_pose_prompt_from_label)
# now live in services/prompts and are imported at the top of this module.


def _unique_prompt_folder_key(
    base_key: str,
    *,
    exists_cb,
    used: set[str],
    suffix_bytes: int = 4,
) -> str:
    key = base_key
    while key in used or exists_cb(key):
        key = sanitize_for_folder(f"{base_key}_{unique_suffix(suffix_bytes)}")
    used.add(key)
    return key


def generate_pose_starting_images_from_prompts(
    character_name: str,
    base_image_path: str,
    prompt_texts: list[str],
    log_cb: Callable[[str], None] | None = None,
    *,
    keypoint_image_path: str | None = None,
) -> list[tuple[str, str]]:
    """
    Generate one flat ``poses/angle_*`` file per prompt text.

    Returns ``(abs_path, storage_rel)`` per row, same shape as
    :func:`generate_pose_starting_image_from_prompt`.
    """
    if base_image_path is None or not Path(base_image_path).is_file():
        raise ValueError("Base image is missing or not a file.")
    prompts = [(p or "").strip() for p in prompt_texts]
    prompts = [p for p in prompts if p]
    kp = (keypoint_image_path or "").strip()
    use_closeup_hint = bool(kp and character_base_closeup_composite_abs_path(character_name))
    if not prompts:
        if kp:
            base_p = DEFAULT_KEYPOINT_ONLY_POSE_PROMPT
            prompts = (
                [_append_closeup_keypoint_pose_hint(base_p)]
                if use_closeup_hint
                else [_append_keypoint_only_pose_hint(base_p)]
            )
        else:
            raise ValueError("No prompt text provided.")
    elif kp:
        if use_closeup_hint:
            prompts = [_append_closeup_keypoint_pose_hint(p) for p in prompts]
        else:
            prompts = [_append_keypoint_only_pose_hint(p) for p in prompts]

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps(prompts),
            *_image_edit_aux_keypoint_cli_args(character_name, keypoint_image_path),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    results: list[dict[str, Any]] = body.get("results") or []
    if len(results) < len(prompts):
        raise RuntimeError(
            f"Image-edit returned {len(results)} results for {len(prompts)} prompts."
        )

    created: list[tuple[str, str]] = []
    for i, prompt in enumerate(prompts):
        stem = sanitize_for_folder(prompt) or f"prompt_{i}"
        url = results[i].get("url")
        if not isinstance(url, str) or not url:
            raise RuntimeError(f"Missing url for prompt index {i}.")
        abs_path, rel = _download_url_to_pose_gallery(character_name, url, stem)
        created.append((abs_path, rel))

    return created


def _generate_pose_image_edit_url(
    character_name: str,
    base_image_path: str,
    prompt_text: str,
    *,
    keypoint_image_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Run image-edit pose generation and return the result URL (no pose gallery save)."""
    effective = (prompt_text or "").strip()
    kp = (keypoint_image_path or "").strip()
    use_closeup_hint = bool(kp and character_base_closeup_composite_abs_path(character_name))
    if not effective:
        if kp:
            base_p = DEFAULT_KEYPOINT_ONLY_POSE_PROMPT
            effective = (
                _append_closeup_keypoint_pose_hint(base_p)
                if use_closeup_hint
                else _append_keypoint_only_pose_hint(base_p)
            )
        else:
            raise ValueError("No prompt text provided.")
    elif kp:
        effective = (
            _append_closeup_keypoint_pose_hint(effective)
            if use_closeup_hint
            else _append_keypoint_only_pose_hint(effective)
        )

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps([effective]),
            *_image_edit_aux_keypoint_cli_args(character_name, keypoint_image_path),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    results: list[dict[str, Any]] = body.get("results") or []
    if not results:
        raise RuntimeError("Image-edit returned no results.")
    url = results[0].get("url")
    if not isinstance(url, str) or not url.strip():
        raise RuntimeError("Image-edit result missing url.")
    return url.strip()


def generate_pose_sequence_from_video_ref(
    char_key: str,
    video_ref_id: str,
    base_image_path: str,
    prompt_texts: list[str],
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Generate one pose image per visible video-ref keypoint frame and store as a
    frameSequence folder inside a new auto-named character sequence.
    """
    from services import reference_storage
    from services.sequence_gallery_strip import gallery_item_from_frame_urls

    entry = reference_storage.get_keypoint_video(video_ref_id)
    if not entry:
        raise ValueError(f"Video reference not found: {video_ref_id}")
    fs = entry.get("frameSequence") or {}
    strip = fs.get("strip") if isinstance(fs.get("strip"), list) else []
    visible = [
        s
        for s in strip
        if isinstance(s, dict)
        and s.get("kind") == "image"
        and not s.get("hidden")
        and str(s.get("relPath") or "").strip()
    ]
    if not visible:
        raise ValueError("Video reference has no visible keypoint frames.")

    prompt = ""
    for p in prompt_texts or []:
        if str(p).strip():
            prompt = str(p).strip()
            break

    base_name = sanitize_for_folder(str(video_ref_id)) or "video"
    ts = int(time.time())
    seq_name = f"video_{base_name}_{ts}"
    existing = set(list_sequence_folder_names(char_key))
    while seq_name in existing:
        seq_name = f"video_{base_name}_{ts}_{unique_suffix(4)}"

    character = get_character_paths(char_key)
    folder = character.sequence_dir(seq_name)
    if folder.exists():
        raise ValueError(f"Sequence {seq_name!r} already exists.")
    ensure_dirs(folder, folder / "gallery", folder / "cells")
    fps = int(entry.get("fps") or 24)
    write_sequence_manifest(
        char_key,
        seq_name,
        {
            "version": 1,
            "fps": fps,
            "gallery": [],
            "frames": [],
            "previewAspect": "16:9",
            "timelineViewStep": 1,
        },
    )

    frame_urls: list[str] = []
    for i, slot in enumerate(visible):
        kp_rel = str(slot.get("relPath") or "").strip()
        if kp_rel.lower().startswith("references/"):
            kp_abs = str(reference_storage.resolve_rel(kp_rel))
        else:
            kp_abs = str(resolve_storage_rel_path_to_abs(kp_rel))
        if log_cb:
            log_cb(f"Generating pose frame {i + 1}/{len(visible)}…")
        url = _generate_pose_image_edit_url(
            char_key,
            base_image_path,
            prompt,
            keypoint_image_path=kp_abs,
            log_cb=log_cb,
        )
        frame_urls.append(url)

    built = gallery_item_from_frame_urls(
        char_key=char_key,
        sequence_name=seq_name,
        frame_urls=frame_urls,
        gallery_subdir_prefix="posevid",
        error_tag="Pose video ref",
    )
    gallery_item = built["galleryItem"]
    manifest = read_sequence_manifest(char_key, seq_name)
    gallery = manifest.get("gallery") if isinstance(manifest.get("gallery"), list) else []
    gallery.append(gallery_item)
    manifest["gallery"] = gallery
    write_sequence_manifest(char_key, seq_name, manifest)
    return {"sequenceName": seq_name, "galleryItemId": gallery_item.get("id")}


def generate_expression_starting_image(
    character_name: str,
    expression_catalog_id: int,
    base_image_path: str | None,
) -> tuple[str, str]:
    if base_image_path is None:
        raise ValueError("Base image is missing; create/save a character first.")
    if expression_catalog_id not in EXPRESSION_BY_ID:
        raise ValueError(f"Unknown expression id: {expression_catalog_id}")

    expr_opt = EXPRESSION_BY_ID[expression_catalog_id]
    indices_json = json.dumps([expr_opt.catalog_index])

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "expression",
            "--indices-json",
            indices_json,
            "--convert-local-to-url",
        ],
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    urls = _extract_image_urls_from_image_edit(body)
    if not urls:
        raise RuntimeError("Image-edit returned no expression urls.")

    url = urls[0]
    catalog_id = body.get("results", [{}])[0].get("catalog_id")
    label = EXPRESSION_BY_ID.get(catalog_id, expr_opt).label
    stem = sanitize_for_folder(label)
    abs_path, rel = _download_url_to_expression_gallery(character_name, url, stem)
    return abs_path, rel


def generate_expression_starting_image_from_prompt(
    character_name: str,
    expression_catalog_id: int,
    base_image_path: str | None,
    prompt_text_override: str | None,
    log_cb: Callable[[str], None] | None = None,
) -> tuple[str, str]:
    """
    Generate an expression starting image using `prompt_source=inline` so the typed prompt can
    override the catalog prompt for the selected expression id.
    """
    if base_image_path is None:
        raise ValueError("Base image is missing; create/save a character first.")
    if expression_catalog_id not in EXPRESSION_BY_ID:
        raise ValueError(f"Unknown expression id: {expression_catalog_id}")

    expr_opt = EXPRESSION_BY_ID[expression_catalog_id]

    effective = (prompt_text_override or "").strip()
    if not effective:
        effective = expr_opt.prompt_text

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps([effective]),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    urls = _extract_image_urls_from_image_edit(body)
    if not urls:
        raise RuntimeError("Image-edit returned no expression urls.")

    url = urls[0]
    stem = sanitize_for_folder(expr_opt.label)
    abs_path, rel = _download_url_to_expression_gallery(character_name, url, stem)
    return abs_path, rel


def generate_expression_starting_images_from_prompts(
    character_name: str,
    base_image_path: str,
    prompt_texts: list[str],
    log_cb: Callable[[str], None] | None = None,
) -> list[tuple[str, str]]:
    """
    Generate one flat ``expressions/angle_*`` file per prompt text.

    Returns ``(abs_path, storage_rel)`` per row.
    """
    if base_image_path is None or not Path(base_image_path).is_file():
        raise ValueError("Base image is missing or not a file.")
    prompts = [(p or "").strip() for p in prompt_texts]
    prompts = [p for p in prompts if p]
    if not prompts:
        raise ValueError("No prompt text provided.")

    body = _run_service_testmode(
        "services.image_edit_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            base_image_path,
            "--prompt-source",
            "inline",
            "--prompts-json",
            json.dumps(prompts),
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    results: list[dict[str, Any]] = body.get("results") or []
    if len(results) < len(prompts):
        raise RuntimeError(
            f"Image-edit returned {len(results)} results for {len(prompts)} prompts."
        )

    created: list[tuple[str, str]] = []
    for i, prompt in enumerate(prompts):
        stem = sanitize_for_folder(prompt) or f"prompt_{i}"
        url = results[i].get("url")
        if not isinstance(url, str) or not url:
            raise RuntimeError(f"Missing url for prompt index {i}.")
        abs_path, rel = _download_url_to_expression_gallery(character_name, url, stem)
        created.append((abs_path, rel))

    return created


def generate_multi_angle_subset_for_pose(
    character_name: str,
    pose_folder_key: str,
    angle_ids: list[int],
    input_image_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    _ = pose_folder_key
    character = get_character_paths(character_name)
    pose_dir = character.poses_dir
    ensure_dirs(pose_dir)
    ordered = _ordered_pose_root_image_abs_paths(character_name)
    angle0_path = _find_first_matching_image(pose_dir, POSE_GALLERY_BASE_STEM)

    requested = {int(a) for a in angle_ids}
    if not requested:
        raise ValueError("Select at least one angle before generating.")

    if input_image_path:
        input_source = Path(input_image_path)
    elif angle0_path is not None:
        input_source = angle0_path
    elif ordered:
        input_source = ordered[0]
    else:
        raise ValueError("No pose gallery image found. Add or generate a pose first.")
    if not input_source.is_file():
        raise ValueError("Angle input image not found.")

    logger.info(
        "Pose multi-angle generation base image: %s",
        input_source,
    )

    angle_id_to_url: dict[int, str] = {}
    errors: list[str] = []
    sorted_ids = sorted(requested)
    total = len(sorted_ids)
    for idx, aid in enumerate(sorted_ids, 1):
        label = angle_ui_label(aid) or f"angle {aid}"
        row = CAMERA_ANGLE_BY_ID.get(aid)
        prompt_hint = (row or {}).get("prompt_text", "")
        if log_cb:
            log_cb(f"[{idx}/{total}] Generating angle {aid}: {label}")
            if prompt_hint:
                log_cb(f"  prompt: {prompt_hint}")
        try:
            body = _run_service_testmode(
                "services.multi_angle_ai_service.serverless",
                [
                    "--test-mode",
                    "--enable-default",
                    "--default-port",
                    str(COMFY_PORT),
                    "--image-url",
                    str(input_source),
                    "--angle-id",
                    str(aid),
                    "--convert-local-to-url",
                ],
                log_cb=log_cb,
            )
            if body.get("error"):
                msg = f"Angle {aid} ({label}): {body['error']}"
                logger.error(msg)
                if log_cb:
                    log_cb(f"  ERROR: {body['error']}")
                errors.append(msg)
                continue

            url = _extract_single_result_url_from_multi_angle(body)
            angle_id_to_url[aid] = url
        except Exception as exc:
            msg = f"Angle {aid} ({label}): {exc}"
            logger.error(msg)
            if log_cb:
                log_cb(f"  ERROR: {exc}")
            errors.append(msg)

    new_paths: list[Path] = []
    input_path = Path(input_source)
    for aid, url in sorted(angle_id_to_url.items(), key=lambda t: t[0]):
        new_paths.append(
            write_multi_angle_appended_stem(
                pose_dir,
                input_path,
                int(aid),
                url,
                ext=infer_ext_from_url(url),
            )
        )

    if new_paths:
        ensure_gallery_flat_migrated(character_name)
        st = read_gallery_ui_state(character_name)
        img_order = _sync_pose_image_order_with_disk(character_name, st)
        after_id: str | None = None
        for iid in reversed(img_order):
            parsed = parse_pose_flat_gallery_item_id(iid)
            if parsed and parsed[0] == POSE_FLAT_BUCKET:
                after_id = iid
                break
        new_ids = [
            pose_flat_gallery_item_id(POSE_FLAT_BUCKET, _abs_to_storage_rel(p))
            for p in new_paths
        ]
        for nid in new_ids:
            while nid in img_order:
                img_order.remove(nid)
        if after_id and after_id in img_order:
            idx = img_order.index(after_id) + 1
            img_order[idx:idx] = new_ids
        else:
            img_order.extend(new_ids)
        st[POSE_IMAGE_ORDER] = img_order
        write_gallery_ui_state(character_name, st)

    if errors and not angle_id_to_url:
        raise RuntimeError(
            f"All {len(errors)} angle(s) failed. First error: {errors[0]}"
        )
    if errors:
        summary = f"{len(angle_id_to_url)} succeeded, {len(errors)} failed"
        if log_cb:
            log_cb(summary)
        return summary
    return "ok"


def generate_multi_angle_subset_for_expression(
    character_name: str,
    expression_folder_key: str,
    angle_ids: list[int],
    input_image_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    _ = expression_folder_key
    character = get_character_paths(character_name)
    expr_dir = character.expressions_dir
    ensure_dirs(expr_dir)
    starting_path = _find_first_matching_image(expr_dir, "starting_image")
    ordered = _ordered_expression_root_image_abs_paths(character_name)

    requested = {int(a) for a in angle_ids}
    if not requested:
        raise ValueError("Select at least one angle before generating.")

    if input_image_path:
        input_source = Path(input_image_path)
    elif starting_path is not None:
        input_source = starting_path
    elif ordered:
        input_source = ordered[0]
    else:
        raise ValueError(
            "No expression gallery image found. Add or generate an expression first."
        )
    if not input_source.is_file():
        raise ValueError("Angle input image not found.")

    logger.info(
        "Expression multi-angle generation base image: %s",
        input_source,
    )

    angle_id_to_url: dict[int, str] = {}
    errors: list[str] = []
    sorted_ids = sorted(requested)
    total = len(sorted_ids)
    for idx, aid in enumerate(sorted_ids, 1):
        label = angle_ui_label(aid) or f"angle {aid}"
        row = CAMERA_ANGLE_BY_ID.get(aid)
        prompt_hint = (row or {}).get("prompt_text", "")
        if log_cb:
            log_cb(f"[{idx}/{total}] Generating angle {aid}: {label}")
            if prompt_hint:
                log_cb(f"  prompt: {prompt_hint}")
        try:
            body = _run_service_testmode(
                "services.multi_angle_ai_service.serverless",
                [
                    "--test-mode",
                    "--enable-default",
                    "--default-port",
                    str(COMFY_PORT),
                    "--image-url",
                    str(input_source),
                    "--angle-id",
                    str(aid),
                    "--convert-local-to-url",
                ],
                log_cb=log_cb,
            )
            if body.get("error"):
                msg = f"Angle {aid} ({label}): {body['error']}"
                logger.error(msg)
                if log_cb:
                    log_cb(f"  ERROR: {body['error']}")
                errors.append(msg)
                continue

            url = _extract_single_result_url_from_multi_angle(body)
            angle_id_to_url[aid] = url
        except Exception as exc:
            msg = f"Angle {aid} ({label}): {exc}"
            logger.error(msg)
            if log_cb:
                log_cb(f"  ERROR: {exc}")
            errors.append(msg)

    new_paths_expr: list[Path] = []
    input_path_expr = Path(input_source)
    for aid, url in sorted(angle_id_to_url.items(), key=lambda t: t[0]):
        new_paths_expr.append(
            write_multi_angle_appended_stem(
                expr_dir,
                input_path_expr,
                int(aid),
                url,
                ext=infer_ext_from_url(url),
            )
        )

    if new_paths_expr:
        ensure_gallery_flat_migrated(character_name)
        st = read_gallery_ui_state(character_name)
        img_order = _sync_expression_image_order_with_disk(character_name, st)
        after_id: str | None = None
        for iid in reversed(img_order):
            parsed = parse_expr_flat_gallery_item_id(iid)
            if parsed and parsed[0] == EXPR_FLAT_BUCKET:
                after_id = iid
                break
        new_ids = [
            expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, _abs_to_storage_rel(p))
            for p in new_paths_expr
        ]
        for nid in new_ids:
            while nid in img_order:
                img_order.remove(nid)
        if after_id and after_id in img_order:
            idx = img_order.index(after_id) + 1
            img_order[idx:idx] = new_ids
        else:
            img_order.extend(new_ids)
        st[EXPR_IMAGE_ORDER] = img_order
        write_gallery_ui_state(character_name, st)

    if errors and not angle_id_to_url:
        raise RuntimeError(
            f"All {len(errors)} angle(s) failed. First error: {errors[0]}"
        )
    if errors:
        summary = f"{len(angle_id_to_url)} succeeded, {len(errors)} failed"
        if log_cb:
            log_cb(summary)
        return summary
    return "ok"


def generate_multi_angle_subset_for_location(
    location_key: str,
    angle_ids: list[int],
    input_image_path: str,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run the same multi-angle Comfy pipeline as pose/expression; write downloads into
    ``locations/<key>/view/`` as ``view_angle_{MMM}_{suffix}.ext``.
    """
    key = sanitize_for_folder(location_key)
    loc_root = (LOCATION_STORAGE_ROOT / key).resolve()
    view_dir = loc_root / "view"
    ensure_dirs(view_dir)

    input_source = Path(input_image_path).resolve()
    if not input_source.is_file():
        raise ValueError("Angle input image not found.")

    requested = {int(a) for a in angle_ids}
    if not requested:
        raise ValueError("Select at least one angle before generating.")

    logger.info("Location multi-angle generation base image: %s", input_source)

    angle_id_to_url: dict[int, str] = {}
    errors: list[str] = []
    sorted_ids = sorted(requested)
    total = len(sorted_ids)
    for idx, aid in enumerate(sorted_ids, 1):
        label = angle_ui_label(aid) or f"angle {aid}"
        row = CAMERA_ANGLE_BY_ID.get(aid)
        prompt_hint = (row or {}).get("prompt_text", "")
        if log_cb:
            log_cb(f"[{idx}/{total}] Generating angle {aid}: {label}")
            if prompt_hint:
                log_cb(f"  prompt: {prompt_hint}")
        try:
            body = _run_service_testmode(
                "services.multi_angle_ai_service.serverless",
                [
                    "--test-mode",
                    "--enable-default",
                    "--default-port",
                    str(COMFY_PORT),
                    "--image-url",
                    str(input_source),
                    "--angle-id",
                    str(aid),
                    "--is-scenery",
                    "--convert-local-to-url",
                ],
                log_cb=log_cb,
            )
            if body.get("error"):
                msg = f"Angle {aid} ({label}): {body['error']}"
                logger.error(msg)
                if log_cb:
                    log_cb(f"  ERROR: {body['error']}")
                errors.append(msg)
                continue

            url = _extract_single_result_url_from_multi_angle(body)
            angle_id_to_url[aid] = url
        except Exception as exc:
            msg = f"Angle {aid} ({label}): {exc}"
            logger.error(msg)
            if log_cb:
                log_cb(f"  ERROR: {exc}")
            errors.append(msg)

    for aid, url in sorted(angle_id_to_url.items(), key=lambda t: t[0]):
        ext_final = infer_ext_from_url(url)
        dest = view_dir / f"view_angle_{int(aid):03d}_{unique_suffix(12)}{ext_final}"
        download_url_to_file(url, dest)

    if errors and not angle_id_to_url:
        raise RuntimeError(
            f"All {len(errors)} angle(s) failed. First error: {errors[0]}"
        )
    if errors:
        summary = f"{len(angle_id_to_url)} succeeded, {len(errors)} failed"
        if log_cb:
            log_cb(summary)
        return summary
    return "ok"


def _next_angle_id_for_gallery_folder(folder: Path) -> int:
    """Next numeric angle id for a new flat file in a pose/expression folder root."""
    max_id = 0
    if folder.exists():
        for p in folder.iterdir():
            if not p.is_file():
                continue
            aid = _parse_angle_id_from_filename(p.name)
            if aid is not None:
                max_id = max(max_id, aid)
    return max_id + 1


def import_manual_multi_angle_image_for_pose(
    character_name: str, pose_folder_key: str, source_path: str | Path
) -> str:
    """
    Copy a user image into the flat ``poses/`` root as ``pose_NNN.ext``.
    """
    _ = pose_folder_key
    src = Path(source_path)
    if not src.is_file():
        raise ValueError("Source image not found.")
    character = get_character_paths(character_name)
    pose_dir = character.poses_dir
    ensure_dirs(pose_dir)
    pid = _next_pose_tile_index_for_new_tile(pose_dir)
    ext = src.suffix if src.suffix else ".png"
    dest = pose_dir / f"pose_{pid:03d}{ext}"
    dest.write_bytes(src.read_bytes())
    ensure_gallery_flat_migrated(character_name)
    st = read_gallery_ui_state(character_name)
    img_order = _sync_pose_image_order_with_disk(character_name, st)
    after_id: str | None = None
    for iid in reversed(img_order):
        parsed = parse_pose_flat_gallery_item_id(iid)
        if parsed and parsed[0] == POSE_FLAT_BUCKET:
            after_id = iid
            break
    new_iid = pose_flat_gallery_item_id(POSE_FLAT_BUCKET, _abs_to_storage_rel(dest))
    while new_iid in img_order:
        img_order.remove(new_iid)
    if after_id and after_id in img_order:
        idx = img_order.index(after_id) + 1
        img_order[idx:idx] = [new_iid]
    else:
        img_order.append(new_iid)
    st[POSE_IMAGE_ORDER] = img_order
    write_gallery_ui_state(character_name, st)
    return str(dest)


def import_manual_multi_angle_image_for_expression(
    character_name: str, expression_folder_key: str, source_path: str | Path
) -> str:
    """Copy into flat ``expressions/`` root as ``expr_NNN.ext``."""
    _ = expression_folder_key
    src = Path(source_path)
    if not src.is_file():
        raise ValueError("Source image not found.")
    character = get_character_paths(character_name)
    expr_dir = character.expressions_dir
    ensure_dirs(expr_dir)
    eid = _next_expr_tile_index_for_new_tile(expr_dir)
    ext = src.suffix if src.suffix else ".png"
    dest = expr_dir / f"expr_{eid:03d}{ext}"
    dest.write_bytes(src.read_bytes())
    ensure_gallery_flat_migrated(character_name)
    st = read_gallery_ui_state(character_name)
    img_order = _sync_expression_image_order_with_disk(character_name, st)
    after_id: str | None = None
    for iid in reversed(img_order):
        parsed = parse_expr_flat_gallery_item_id(iid)
        if parsed and parsed[0] == EXPR_FLAT_BUCKET:
            after_id = iid
            break
    new_iid = expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, _abs_to_storage_rel(dest))
    while new_iid in img_order:
        img_order.remove(new_iid)
    if after_id and after_id in img_order:
        idx = img_order.index(after_id) + 1
        img_order[idx:idx] = [new_iid]
    else:
        img_order.append(new_iid)
    st[EXPR_IMAGE_ORDER] = img_order
    write_gallery_ui_state(character_name, st)
    return str(dest)


def _pose_multi_angle_base_abs_path(
    character_name: str, pose_folder_key: str, input_abs: str
) -> str:
    """
    Absolute path to use as Comfy input for multi-angle: existing flat ``poses/`` file
    is reused; anything else is copied in via ``import_manual_multi_angle_image_for_pose``.
    """
    character = get_character_paths(character_name)
    root = character.poses_dir.resolve()
    src = Path(input_abs).resolve()
    if not src.is_file():
        raise ValueError("Source image not found.")
    if src.parent.resolve() == root:
        return str(src)
    return import_manual_multi_angle_image_for_pose(
        character_name, pose_folder_key, input_abs
    )


def _expression_multi_angle_base_abs_path(
    character_name: str, expression_folder_key: str, input_abs: str
) -> str:
    """Same as :func:`_pose_multi_angle_base_abs_path` for flat ``expressions/``."""
    character = get_character_paths(character_name)
    root = character.expressions_dir.resolve()
    src = Path(input_abs).resolve()
    if not src.is_file():
        raise ValueError("Source image not found.")
    if src.parent.resolve() == root:
        return str(src)
    return import_manual_multi_angle_image_for_expression(
        character_name, expression_folder_key, input_abs
    )


def run_pose_multi_angle_ws_job(
    character_name: str,
    pose_folder_key: str,
    angle_ids: list[int],
    input_abs_resolved_paths: list[str],
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    WebSocket ``angles`` job for poses: optionally import each resolved path into the
    flat gallery, then run multi-angle generation. When ``angle_ids`` is empty, only
    imports run. When ``angle_ids`` is non-empty and the input list is empty, generation
    uses the default base (``pose_000`` / first ordered pose). When both are
    non-empty, each input is used as the Comfy base for a full pass over ``angle_ids``
    (N inputs ⇒ N full batches). Paths that already sit directly under flat ``poses/``
    skip the import copy to avoid duplicate tiles.
    """
    if not angle_ids:
        for input_abs in input_abs_resolved_paths:
            character = get_character_paths(character_name)
            root = character.poses_dir.resolve()
            src = Path(input_abs).resolve()
            if not src.is_file():
                raise ValueError("Source image not found.")
            if src.parent.resolve() == root:
                continue
            import_manual_multi_angle_image_for_pose(
                character_name, pose_folder_key, input_abs
            )
        return "ok"
    if not input_abs_resolved_paths:
        return generate_multi_angle_subset_for_pose(
            character_name,
            pose_folder_key,
            angle_ids,
            input_image_path=None,
            log_cb=log_cb,
        )
    last: str = "ok"
    for input_abs in input_abs_resolved_paths:
        dest = _pose_multi_angle_base_abs_path(
            character_name, pose_folder_key, input_abs
        )
        last = generate_multi_angle_subset_for_pose(
            character_name,
            pose_folder_key,
            angle_ids,
            input_image_path=dest,
            log_cb=log_cb,
        )
    return last


def run_expression_multi_angle_ws_job(
    character_name: str,
    expression_folder_key: str,
    angle_ids: list[int],
    input_abs_resolved_paths: list[str],
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Same contract as :func:`run_pose_multi_angle_ws_job` for expression galleries."""
    if not angle_ids:
        for input_abs in input_abs_resolved_paths:
            character = get_character_paths(character_name)
            root = character.expressions_dir.resolve()
            src = Path(input_abs).resolve()
            if not src.is_file():
                raise ValueError("Source image not found.")
            if src.parent.resolve() == root:
                continue
            import_manual_multi_angle_image_for_expression(
                character_name, expression_folder_key, input_abs
            )
        return "ok"
    if not input_abs_resolved_paths:
        return generate_multi_angle_subset_for_expression(
            character_name,
            expression_folder_key,
            angle_ids,
            input_image_path=None,
            log_cb=log_cb,
        )
    last: str = "ok"
    for input_abs in input_abs_resolved_paths:
        dest = _expression_multi_angle_base_abs_path(
            character_name, expression_folder_key, input_abs
        )
        last = generate_multi_angle_subset_for_expression(
            character_name,
            expression_folder_key,
            angle_ids,
            input_image_path=dest,
            log_cb=log_cb,
        )
    return last


def _assert_abs_file_under_dir(path: Path, root: Path) -> None:
    path = path.resolve()
    root = root.resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise ValueError(f"Source file is not under expected folder: {path}") from None


def ai_edit_pose_in_bucket(
    char_key: str,
    *,
    pose_key: str,
    source_image_abs_path: str,
    prompt_text: str,
    mask_abs_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    AI-edit a pose gallery image and save under ``poses/`` as
    ``<source_stem>_edit_<k:03d>.<ext>``.
    Returns the edited image absolute path.
    """
    _ = pose_key
    character = get_character_paths(char_key)
    pose_dir = character.poses_dir
    src = Path(source_image_abs_path)
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")
    _assert_abs_file_under_dir(src, pose_dir)

    edited_url = _run_inline_edit_or_mask(
        input_image_abs_path=source_image_abs_path,
        prompt_text=prompt_text,
        mask_abs_path=mask_abs_path,
        log_cb=log_cb,
    )

    ensure_dirs(pose_dir)
    stem = src.stem
    edited_index = _next_edit_suffix_index(pose_dir, stem)
    ext = infer_ext_from_url(edited_url)
    dest = pose_dir / f"{stem}_edit_{edited_index:03d}{ext}"
    download_url_to_file(edited_url, dest)
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    img_order = _sync_pose_image_order_with_disk(char_key, st)
    after_id: str | None = None
    for iid in reversed(img_order):
        parsed = parse_pose_flat_gallery_item_id(iid)
        if parsed and parsed[0] == POSE_FLAT_BUCKET:
            after_id = iid
            break
    new_iid = pose_flat_gallery_item_id(POSE_FLAT_BUCKET, _abs_to_storage_rel(dest))
    while new_iid in img_order:
        img_order.remove(new_iid)
    if after_id and after_id in img_order:
        idx = img_order.index(after_id) + 1
        img_order[idx:idx] = [new_iid]
    else:
        img_order.append(new_iid)
    st[POSE_IMAGE_ORDER] = img_order
    write_gallery_ui_state(char_key, st)
    return str(dest)


def ai_edit_expression_in_bucket(
    char_key: str,
    *,
    expr_key: str,
    source_image_abs_path: str,
    prompt_text: str,
    mask_abs_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Same as :func:`ai_edit_pose_in_bucket` for flat ``expressions/``.
    """
    _ = expr_key
    character = get_character_paths(char_key)
    expr_dir = character.expressions_dir
    src = Path(source_image_abs_path)
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")
    _assert_abs_file_under_dir(src, expr_dir)

    edited_url = _run_inline_edit_or_mask(
        input_image_abs_path=source_image_abs_path,
        prompt_text=prompt_text,
        mask_abs_path=mask_abs_path,
        log_cb=log_cb,
    )

    ensure_dirs(expr_dir)
    stem = src.stem
    edited_index = _next_edit_suffix_index(expr_dir, stem)
    ext = infer_ext_from_url(edited_url)
    dest = expr_dir / f"{stem}_edit_{edited_index:03d}{ext}"
    download_url_to_file(edited_url, dest)
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    img_order = _sync_expression_image_order_with_disk(char_key, st)
    after_id: str | None = None
    for iid in reversed(img_order):
        parsed = parse_expr_flat_gallery_item_id(iid)
        if parsed and parsed[0] == EXPR_FLAT_BUCKET:
            after_id = iid
            break
    new_iid = expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, _abs_to_storage_rel(dest))
    while new_iid in img_order:
        img_order.remove(new_iid)
    if after_id and after_id in img_order:
        idx = img_order.index(after_id) + 1
        img_order[idx:idx] = [new_iid]
    else:
        img_order.append(new_iid)
    st[EXPR_IMAGE_ORDER] = img_order
    write_gallery_ui_state(char_key, st)
    return str(dest)


def ai_edit_image_inline_to_temp_file(
    *,
    input_image_abs_path: str,
    prompt_text: str,
    mask_abs_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Utility: run the inline image-edit service and download the result
    into a temp file. Caller can persist it wherever needed.
    """
    edited_url = _run_inline_edit_or_mask(
        input_image_abs_path=input_image_abs_path,
        prompt_text=prompt_text,
        mask_abs_path=mask_abs_path,
        log_cb=log_cb,
    )
    ext = infer_ext_from_url(edited_url)
    dest = Path(tempfile.gettempdir()) / f"ai_edit_{unique_suffix()}{ext}"
    download_url_to_file(edited_url, dest)
    return str(dest)


def ai_edit_image_inline_to_dataset_file(
    *,
    char_key: str,
    dataset_name: str,
    source_image_abs_path: str,
    prompt_text: str,
    mask_abs_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run image-edit and persist the edited output into:
      <character>/dataset/<dataset_name>/

    Returns the edited output absolute path.
    """
    character = get_character_paths(char_key)
    dataset_dir = character.dataset_dir(dataset_name)
    ensure_dirs(dataset_dir)

    src = Path(source_image_abs_path)
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")

    edited_url = _run_inline_edit_or_mask(
        input_image_abs_path=source_image_abs_path,
        prompt_text=prompt_text,
        mask_abs_path=mask_abs_path,
        log_cb=log_cb,
    )
    ext = infer_ext_from_url(edited_url)

    src_stem = sanitize_for_folder(src.stem, max_len=80)
    base = f"{src_stem}_ai_edit"
    i = 0
    while True:
        cand = sanitize_for_folder(f"{base}_{i}", max_len=80)
        dest = dataset_dir / f"{cand}{ext}"
        if not dest.exists():
            download_url_to_file(edited_url, dest)
            return str(dest)
        i += 1


def ai_edit_sequence_gallery_image(
    *,
    char_key: str,
    sequence_name: str,
    source_image_abs_path: str,
    prompt_text: str,
    mask_abs_path: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run image-edit and persist the edited output into:
      <character>/sequences/<sequence_name>/gallery/

    Returns the edited output absolute path.
    """
    seq_folder = sequence_folder_path(char_key, sequence_name).resolve()
    gallery_dir = (seq_folder / "gallery").resolve()
    ensure_dirs(gallery_dir)

    src = Path(source_image_abs_path).resolve()
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")
    try:
        src.relative_to(gallery_dir)
    except ValueError as ex:
        raise ValueError(
            "AI edit sequence gallery: source image must be under sequence/<name>/gallery/"
        ) from ex

    temp_path = ai_edit_image_inline_to_temp_file(
        input_image_abs_path=str(src),
        prompt_text=prompt_text,
        mask_abs_path=mask_abs_path,
        log_cb=log_cb,
    )
    try:
        tmp = Path(temp_path).resolve()
        ext = tmp.suffix.lower() or src.suffix.lower() or ".png"
        if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
            ext = ".png"
        dest = gallery_dir / f"gal_{unique_suffix(12)}{ext}"
        shutil.copy2(tmp, dest)
        return str(dest)
    finally:
        Path(temp_path).unlink(missing_ok=True)


def parse_angle_ids(text: str) -> list[int]:
    cleaned = text.replace(",", " ").strip()
    if not cleaned:
        return []
    parts = [p for p in cleaned.split(" ") if p.strip()]
    out: list[int] = []
    for p in parts:
        out.append(int(p))
    return [a for a in out if 0 <= a <= 95]


@dataclass
class CharacterViewState:
    base_image_path: str | None
    base_path_for_gen: str | None
    pose_folders: list[str]
    selected_pose_folder: str | None
    expression_folders: list[str]
    selected_expression_folder: str | None
    pose_starting_preview: str | None
    pose_angle0: str | None
    pose_multi_paths: list[str]
    expression_starting_preview: str | None
    expression_angle0: str | None
    expression_multi_paths: list[str]
    pose_label_state: str | None
    expression_label_state: str | None


def empty_character_view() -> CharacterViewState:
    return CharacterViewState(
        None,
        None,
        [],
        None,
        [],
        None,
        None,
        None,
        [],
        None,
        None,
        [],
        None,
        None,
    )


def load_character_view(char_key: str | None) -> CharacterViewState:
    if not char_key:
        return empty_character_view()

    ensure_gallery_flat_migrated(char_key)
    character = get_character_paths(char_key)
    base = _find_first_matching_image(character.base_dir, "base")
    pose_dirs: list[str] = (
        [POSE_FLAT_BUCKET] if _pose_gallery_root_image_paths(char_key) else []
    )
    expr_dirs: list[str] = (
        [EXPR_FLAT_BUCKET] if _expression_gallery_root_image_paths(char_key) else []
    )

    pose_preview_path: str | None = None
    pose_angle0_path: str | None = None
    pose_multi_imgs: list[str] = []
    if character.poses_dir.is_dir():
        pa = _find_first_matching_image(character.poses_dir, POSE_GALLERY_BASE_STEM)
        pose_ordered = _ordered_pose_root_image_abs_paths(char_key)
        pose_preview_path = str(pose_ordered[0]) if pose_ordered else None
        pose_angle0_path = str(pa) if pa else None

    expr_start: str | None = None
    expr_a0: str | None = None
    expr_multi_imgs: list[str] = []
    if character.expressions_dir.is_dir():
        es = _find_first_matching_image(character.expressions_dir, "starting_image")
        ea = _find_first_matching_image(character.expressions_dir, EXPR_GALLERY_BASE_STEM)
        expr_start = str(es) if es else None
        expr_a0 = str(ea) if ea else None

    default_pose_key = pose_dirs[0] if pose_dirs else None
    default_expr_key = expr_dirs[0] if expr_dirs else None

    b = str(base) if base else None
    return CharacterViewState(
        b,
        b,
        pose_dirs,
        default_pose_key,
        expr_dirs,
        default_expr_key,
        pose_preview_path,
        pose_angle0_path,
        pose_multi_imgs,
        expr_start,
        expr_a0,
        expr_multi_imgs,
        default_pose_key,
        default_expr_key,
    )


def refresh_pose_view(char_key: str | None, pose_key: str | None) -> tuple[str | None, str | None, list[str], str | None]:
    if not char_key:
        return None, None, [], pose_key
    character = get_character_paths(char_key)
    root = character.poses_dir
    angle0 = _find_first_matching_image(root, POSE_GALLERY_BASE_STEM)
    ordered = _ordered_pose_root_image_abs_paths(char_key) if root.is_dir() else []
    pk = pose_key or POSE_FLAT_BUCKET
    preview = str(angle0) if angle0 else (str(ordered[0]) if ordered else None)
    return (
        preview,
        str(angle0) if angle0 else None,
        [],
        pk,
    )


def list_pose_gallery_items(char_key: str) -> list[tuple[str, str]]:
    """Return ``(flat_bucket, preview_abs_path)`` for the flat pose gallery."""
    ensure_gallery_flat_migrated(char_key)
    files = _ordered_pose_root_image_abs_paths(char_key)
    if not files:
        return []
    return [(POSE_FLAT_BUCKET, str(files[0]))]


def ensure_base_pose_in_gallery(
    character_name: str,
    *,
    pose_folder_key: str = "",
) -> str | None:
    """
    Ensure the full-body base is visible in the flat pose gallery as ``poses/pose_000.<ext>``.

    Uses ``character_base_source_image_path`` (``base_img`` then legacy ``base``).

    Returns storage-relative path to ``pose_000`` when ensured or already present,
    otherwise None when no base image exists.
    """
    _ = pose_folder_key
    character = get_character_paths(character_name)
    src_s = character_base_source_image_path(character_name)
    if not src_s:
        return None
    base_src = Path(src_s)
    if not base_src.is_file():
        return None

    ensure_dirs(character.poses_dir)
    angle0 = _find_first_matching_image(character.poses_dir, POSE_GALLERY_BASE_STEM)
    if angle0 is None:
        ext = base_src.suffix or ".png"
        dest = character.poses_dir / f"{POSE_GALLERY_BASE_STEM}{ext}"
        dest.write_bytes(base_src.read_bytes())
        ensure_gallery_flat_migrated(character_name)
        st = read_gallery_ui_state(character_name)
        iid = pose_flat_gallery_item_id(POSE_FLAT_BUCKET, _abs_to_storage_rel(dest))
        order = _sync_pose_image_order_with_disk(character_name, st)
        while iid in order:
            order.remove(iid)
        order.insert(0, iid)
        st[POSE_IMAGE_ORDER] = order
        st[POSE_KEY_ORDER] = [POSE_FLAT_BUCKET]
        write_gallery_ui_state(character_name, st)
        angle0 = dest
    else:
        ensure_gallery_flat_migrated(character_name)

    return _abs_to_storage_rel(angle0) if angle0.is_file() else None


def _parse_angle_id_from_filename(name: str) -> int | None:
    m = re.match(r"^angle_(\d+)_", name)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _read_angle_order_file(multi_dir: Path) -> list[str] | None:
    p = multi_dir / "order.json"
    if not p.is_file():
        return None
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        order = list((data or {}).get("order") or [])
        out: list[str] = []
        for x in order:
            s = str(x).strip()
            if s:
                out.append(Path(s).name)
        return out
    except Exception:
        return None


def _write_angle_order_file(multi_dir: Path, filenames: list[str]) -> None:
    ensure_dirs(multi_dir)
    safe: list[str] = []
    seen: set[str] = set()
    for n in filenames or []:
        bn = Path(str(n)).name
        if not bn:
            continue
        if bn in seen:
            continue
        seen.add(bn)
        safe.append(bn)
    with open(multi_dir / "order.json", "w", encoding="utf-8") as f:
        json.dump({"version": 1, "order": safe}, f, indent=2)


def set_pose_angle_order(char_key: str, pose_key: str, filenames: list[str]) -> None:
    """Reorder all images in the flat ``poses/`` gallery."""
    _ = pose_key
    ensure_gallery_flat_migrated(char_key)
    character = get_character_paths(char_key)
    pose_dir = character.poses_dir
    if not pose_dir.is_dir():
        return
    by_name = {p.name: p for p in pose_dir.iterdir() if _is_gallery_image_file(p)}
    ordered_names: list[str] = []
    seen_n: set[str] = set()
    for n in filenames or []:
        bn = Path(str(n)).name
        if bn in by_name and bn not in seen_n:
            ordered_names.append(bn)
            seen_n.add(bn)
    for bn in sorted(by_name.keys(), key=lambda s: s.lower()):
        if bn not in seen_n:
            ordered_names.append(bn)
            seen_n.add(bn)
    wanted = [
        pose_flat_gallery_item_id(POSE_FLAT_BUCKET, _abs_to_storage_rel(by_name[b]))
        for b in ordered_names
    ]
    st = read_gallery_ui_state(char_key)
    order = _sync_pose_image_order_with_disk(char_key, st)
    first: int | None = None
    for i, x in enumerate(order):
        pr = parse_pose_flat_gallery_item_id(x)
        if pr and pr[0] == POSE_FLAT_BUCKET:
            first = i
            break
    if first is None:
        new_order = order + wanted
    else:
        j = first
        while j < len(order):
            pr = parse_pose_flat_gallery_item_id(order[j])
            if pr and pr[0] == POSE_FLAT_BUCKET:
                j += 1
            else:
                break
        new_order = order[:first] + wanted + order[j:]
    st[POSE_IMAGE_ORDER] = new_order
    write_gallery_ui_state(char_key, st)


def set_expression_angle_order(char_key: str, expr_key: str, filenames: list[str]) -> None:
    _ = expr_key
    ensure_gallery_flat_migrated(char_key)
    character = get_character_paths(char_key)
    expr_dir = character.expressions_dir
    if not expr_dir.is_dir():
        return
    by_name = {p.name: p for p in expr_dir.iterdir() if _is_gallery_image_file(p)}
    ordered_names: list[str] = []
    seen_n: set[str] = set()
    for n in filenames or []:
        bn = Path(str(n)).name
        if bn in by_name and bn not in seen_n:
            ordered_names.append(bn)
            seen_n.add(bn)
    for bn in sorted(by_name.keys(), key=lambda s: s.lower()):
        if bn not in seen_n:
            ordered_names.append(bn)
            seen_n.add(bn)
    wanted = [
        expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, _abs_to_storage_rel(by_name[b]))
        for b in ordered_names
    ]
    st = read_gallery_ui_state(char_key)
    order = _sync_expression_image_order_with_disk(char_key, st)
    first: int | None = None
    for i, x in enumerate(order):
        pr = parse_expr_flat_gallery_item_id(x)
        if pr and pr[0] == EXPR_FLAT_BUCKET:
            first = i
            break
    if first is None:
        new_order = order + wanted
    else:
        j = first
        while j < len(order):
            pr = parse_expr_flat_gallery_item_id(order[j])
            if pr and pr[0] == EXPR_FLAT_BUCKET:
                j += 1
            else:
                break
        new_order = order[:first] + wanted + order[j:]
    st[EXPR_IMAGE_ORDER] = new_order
    write_gallery_ui_state(char_key, st)


def _merge_angle_items_by_id(items: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """One path per angle id; newest (lexicographically last) path wins."""
    by_id: dict[int, str] = {}
    for aid, path in sorted(items, key=lambda t: (t[0], t[1]), reverse=True):
        p = Path(path)
        if not p.is_file():
            continue
        if aid not in by_id:
            by_id[aid] = path
    return [(aid, by_id[aid]) for aid in sorted(by_id.keys())]


def _dedupe_angle_gallery_by_content(items: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """Drop lower-priority angles whose image file is byte-identical to an earlier angle."""
    out: list[tuple[int, str]] = []
    kept_paths: list[str] = []
    for aid, path in sorted(items, key=lambda t: t[0]):
        p = Path(path)
        if not p.is_file():
            continue
        if any(_paths_same_file_or_identical_bytes(p, Path(k)) for k in kept_paths):
            logger.warning(
                "Angle gallery dedup: dropping angle %d (%s) — byte-identical "
                "to an earlier angle image",
                aid,
                Path(path).name,
            )
            continue
        kept_paths.append(path)
        out.append((aid, path))
    return out


def _is_flat_pose_starting_image_filename(filename: str) -> bool:
    """True for legacy ``starting_image.*`` files at the flat ``poses/`` root (excluded from gallery)."""
    return Path(filename).stem.lower().startswith("starting_image")


def _migrate_flat_pose_starting_image_to_pose_000_if_needed(poses_root: Path) -> None:
    """
    If ``pose_000`` is missing but ``starting_image.*`` exists at ``poses/`` root,
    rename it to ``pose_000`` so older installs keep a canonical tile.
    """
    if not poses_root.is_dir():
        return
    if _find_first_matching_image(poses_root, POSE_GALLERY_BASE_STEM) is not None:
        return
    start = _find_first_matching_image(poses_root, "starting_image")
    if start is None or not start.is_file():
        return
    ext = start.suffix.lower() or ".png"
    dest = poses_root / f"{POSE_GALLERY_BASE_STEM}{ext}"
    if dest.exists():
        return
    start.rename(dest)


def list_pose_angle_gallery_items(
    char_key: str,
    pose_key: str,
    include_angle0: bool = True,
) -> list[tuple[int, str]]:
    _ = pose_key
    character = get_character_paths(char_key)
    pose_dir = character.poses_dir
    items: list[tuple[int, str]] = []

    if pose_dir.is_dir():
        _migrate_flat_pose_starting_image_to_pose_000_if_needed(pose_dir)
    if include_angle0:
        angle0 = _find_first_matching_image(
            pose_dir, POSE_GALLERY_BASE_STEM
        ) or _find_first_matching_image(pose_dir, "angle_000")
        if angle0 is not None:
            items.append((0, str(angle0)))

    multi_dir = pose_dir / f"{pose_dir.name}_multi_angle"
    extra_paths: list[Path] = []
    if multi_dir.exists():
        files = [p for p in multi_dir.iterdir() if p.is_file() and _is_gallery_image_file(p)]
        order = _read_angle_order_file(multi_dir) or []
        by_name = {p.name: p for p in files}
        ordered: list[Path] = []
        for n in order:
            p = by_name.get(n)
            if p is not None:
                ordered.append(p)
        ordered_names = {p.name for p in ordered}
        for p in sorted(files, key=lambda x: x.name.lower()):
            if p.name in ordered_names:
                continue
            ordered.append(p)
        extra_paths.extend(ordered)
    seen_abs: set[str] = set()
    for _aid, ap in items:
        seen_abs.add(str(Path(ap).resolve()))
    for p in sorted(
        [
            x
            for x in pose_dir.iterdir()
            if _is_gallery_image_file(x) and not _is_flat_pose_starting_image_filename(x.name)
        ],
        key=lambda x: x.name.lower(),
    ):
        if str(p.resolve()) in seen_abs:
            continue
        seen_abs.add(str(p.resolve()))
        extra_paths.append(p)
    for p in extra_paths:
        aid = _camera_angle_id_for_listing(p.stem)
        items.append((aid, str(p)))

    # Keep one tile per file (even if multiple files share the same numeric
    # `angle_<id>` prefix). This enables edited angle copies to show as
    # separate thumbnails.
    items.sort(key=lambda t: (t[0], Path(t[1]).name.lower()))
    if not include_angle0:
        return [(a, p) for a, p in items if a != 0]
    return items


def list_expression_gallery_items(char_key: str) -> list[tuple[str, str]]:
    ensure_gallery_flat_migrated(char_key)
    files = _ordered_expression_root_image_abs_paths(char_key)
    if not files:
        return []
    return [(EXPR_FLAT_BUCKET, str(files[0]))]


def list_expression_angle_gallery_items(
    char_key: str,
    expr_key: str,
    include_angle0: bool = True,
) -> list[tuple[int, str]]:
    _ = expr_key
    character = get_character_paths(char_key)
    expr_dir = character.expressions_dir
    items: list[tuple[int, str]] = []

    starting = _find_first_matching_image(expr_dir, "starting_image")
    if include_angle0:
        angle0 = _find_first_matching_image(
            expr_dir, EXPR_GALLERY_BASE_STEM
        ) or _find_first_matching_image(expr_dir, "angle_000")
        if angle0 is not None:
            items.append((0, str(angle0)))
        elif starting is not None:
            items.append((0, str(starting)))

    multi_dir = expr_dir / f"{expr_dir.name}_multi_angle"
    extra_paths_e: list[Path] = []
    if multi_dir.exists():
        files = [p for p in multi_dir.iterdir() if p.is_file() and _is_gallery_image_file(p)]
        order = _read_angle_order_file(multi_dir) or []
        by_name = {p.name: p for p in files}
        ordered: list[Path] = []
        for n in order:
            p = by_name.get(n)
            if p is not None:
                ordered.append(p)
        ordered_names = {p.name for p in ordered}
        for p in sorted(files, key=lambda x: x.name.lower()):
            if p.name in ordered_names:
                continue
            ordered.append(p)
        extra_paths_e.extend(ordered)
    seen_abs_e: set[str] = set()
    for _aid, ap in items:
        seen_abs_e.add(str(Path(ap).resolve()))
    for p in sorted(
        [x for x in expr_dir.iterdir() if _is_gallery_image_file(x)],
        key=lambda x: x.name.lower(),
    ):
        if str(p.resolve()) in seen_abs_e:
            continue
        seen_abs_e.add(str(p.resolve()))
        extra_paths_e.append(p)
    for p in extra_paths_e:
        aid = _camera_angle_id_for_listing(p.stem)
        items.append((aid, str(p)))

    items.sort(key=lambda t: (t[0], Path(t[1]).name.lower()))
    if not include_angle0:
        return [(a, p) for a, p in items if a != 0]
    return items


def import_external_pose_starting_image(
    character_name: str,
    pose_folder_name: str,
    source_path: str | Path,
) -> str:
    """
    Copy an import into flat ``poses/`` as ``pose_NNN.<ext>``.

    Returns storage-relative path to the new file.
    """
    character = get_character_paths(character_name)
    ensure_dirs(character.poses_dir)
    _ = sanitize_for_folder(pose_folder_name) or "import"
    src = Path(source_path)
    if not src.is_file():
        raise ValueError("Source image not found.")
    pid = _next_pose_tile_index_for_new_tile(character.poses_dir)
    ext = src.suffix.lower() or ".png"
    dest = character.poses_dir / f"pose_{pid:03d}{ext}"
    dest.write_bytes(src.read_bytes())
    rel = _append_pose_gallery_file_to_order(character_name, dest)
    st = read_gallery_ui_state(character_name)
    st[POSE_KEY_ORDER] = [POSE_FLAT_BUCKET]
    write_gallery_ui_state(character_name, st)
    return rel


def import_external_expression_starting_image(
    character_name: str,
    expression_folder_name: str,
    source_path: str | Path,
) -> str:
    """
    Copy an import into flat ``expressions/`` as ``expr_NNN.<ext>``.

    Returns storage-relative path to the new file.
    """
    character = get_character_paths(character_name)
    ensure_dirs(character.expressions_dir)
    _ = sanitize_for_folder(expression_folder_name) or "import"
    src = Path(source_path)
    if not src.is_file():
        raise ValueError("Source image not found.")
    eid = _next_expr_tile_index_for_new_tile(character.expressions_dir)
    ext = src.suffix.lower() or ".png"
    dest = character.expressions_dir / f"expr_{eid:03d}{ext}"
    dest.write_bytes(src.read_bytes())
    rel = _append_expr_gallery_file_to_order(character_name, dest)
    st = read_gallery_ui_state(character_name)
    st[EXPR_KEY_ORDER] = [EXPR_FLAT_BUCKET]
    write_gallery_ui_state(character_name, st)
    return rel


def import_expression_starting_from_gallery_rel_path(
    character_name: str,
    source_storage_rel: str,
    *,
    expression_folder_name: str | None = None,
) -> str:
    """
    Copy an image already under this character's ``poses/`` or ``expressions/`` gallery
    into flat ``expressions/`` as ``expr_NNN.<ext>``.

    Avoids client re-upload (multipart / dev-proxy timeouts) when picking from the library.
    """
    character = get_character_paths(character_name)
    char_root = character.character_dir.resolve()
    rel_norm = source_storage_rel.replace("\\", "/").lstrip("/")
    abs_src = (DEFAULT_STORAGE_ROOT / rel_norm).resolve()
    root_storage = DEFAULT_STORAGE_ROOT.resolve()
    if root_storage != abs_src and root_storage not in abs_src.parents:
        raise ValueError("Source path escapes storage root.")
    if char_root != abs_src and char_root not in abs_src.parents:
        raise ValueError("Source image is outside this character folder.")
    if not abs_src.is_file():
        raise ValueError("Source image not found.")
    try:
        rel_to_char = abs_src.relative_to(char_root)
    except ValueError as e:
        raise ValueError("Source must be under the character folder.") from e
    top = rel_to_char.parts[0] if rel_to_char.parts else ""
    if top not in ("poses", "expressions"):
        raise ValueError("Source must be under poses/ or expressions/.")
    if not _is_gallery_image_file(abs_src):
        raise ValueError("Source must be a supported image file.")
    label = (expression_folder_name or "").strip() or abs_src.stem or "import"
    return import_external_expression_starting_image(character_name, label, abs_src)


def import_pose_starting_from_gallery_rel_path(
    character_name: str,
    source_storage_rel: str,
    *,
    pose_folder_name: str | None = None,
) -> str:
    """Copy an image under this character's ``poses/`` or ``expressions/`` into flat ``poses/``."""
    character = get_character_paths(character_name)
    char_root = character.character_dir.resolve()
    rel_norm = source_storage_rel.replace("\\", "/").lstrip("/")
    abs_src = (DEFAULT_STORAGE_ROOT / rel_norm).resolve()
    root_storage = DEFAULT_STORAGE_ROOT.resolve()
    if root_storage != abs_src and root_storage not in abs_src.parents:
        raise ValueError("Source path escapes storage root.")
    if char_root != abs_src and char_root not in abs_src.parents:
        raise ValueError("Source image is outside this character folder.")
    if not abs_src.is_file():
        raise ValueError("Source image not found.")
    try:
        rel_to_char = abs_src.relative_to(char_root)
    except ValueError as e:
        raise ValueError("Source must be under the character folder.") from e
    top = rel_to_char.parts[0] if rel_to_char.parts else ""
    if top not in ("poses", "expressions"):
        raise ValueError("Source must be under poses/ or expressions/.")
    if not _is_gallery_image_file(abs_src):
        raise ValueError("Source must be a supported image file.")
    label = (pose_folder_name or "").strip() or abs_src.stem or "import"
    return import_external_pose_starting_image(character_name, label, abs_src)


def refresh_expression_view(
    char_key: str | None, expr_key: str | None
) -> tuple[str | None, str | None, list[str], str | None]:
    if not char_key:
        return None, None, [], expr_key
    character = get_character_paths(char_key)
    root = character.expressions_dir
    starting = _find_first_matching_image(root, "starting_image")
    angle0 = _find_first_matching_image(root, EXPR_GALLERY_BASE_STEM)
    ek = expr_key or EXPR_FLAT_BUCKET
    return (
        str(starting) if starting else None,
        str(angle0) if angle0 else None,
        [],
        ek,
    )


GALLERY_UI_STATE_FILENAME = "gallery_ui_state.json"
# Logical bucket id inside ``pimg:`` / ``eimg:`` item ids (not a filesystem folder).
POSE_FLAT_BUCKET = "flat"
EXPR_FLAT_BUCKET = "flat"
POSE_KEY_ORDER = "pose_key_order"
EXPR_KEY_ORDER = "expression_key_order"
POSE_IMAGE_ORDER = "pose_image_order"
HIDDEN_POSE_IMAGES = "hidden_pose_images"
EXPR_IMAGE_ORDER = "expression_image_order"
HIDDEN_EXPR_IMAGES = "hidden_expression_images"
GALLERY_FLAT_MIGRATED_V1 = "gallery_flat_migrated_v1"
GALLERY_LAYOUT_V2 = "gallery_layout_v2"
GALLERY_FILENAME_V3 = "gallery_filename_v3"
SEQUENCE_FOLDER_ORDER = "sequence_folder_order"

POSE_GALLERY_BASE_STEM = "pose_000"
EXPR_GALLERY_BASE_STEM = "expr_000"


def _gallery_ui_state_path(char_key: str) -> Path:
    character = get_character_paths(char_key)
    return character.character_dir / GALLERY_UI_STATE_FILENAME


def _is_gallery_image_file(p: Path) -> bool:
    return p.is_file() and p.suffix.lower() in _DRAFT_IMAGE_EXTS


def _pose_tile_index_from_stem(stem: str) -> int | None:
    m = re.match(r"^pose_(\d{3})", stem, flags=re.I)
    return int(m.group(1)) if m else None


def _expr_tile_index_from_stem(stem: str) -> int | None:
    m = re.match(r"^expr_(\d{3})", stem, flags=re.I)
    return int(m.group(1)) if m else None


def _max_pose_tile_index_in_dir(poses_dir: Path) -> int:
    max_n = -1
    if not poses_dir.is_dir():
        return max_n
    for p in poses_dir.iterdir():
        if not _is_gallery_image_file(p):
            continue
        n = _pose_tile_index_from_stem(p.stem)
        if n is not None:
            max_n = max(max_n, n)
    return max_n


def _next_pose_tile_index_for_new_tile(poses_dir: Path) -> int:
    """Next pose tile index for generated/imported tiles (``pose_000`` reserved for base sync)."""
    return max(_max_pose_tile_index_in_dir(poses_dir) + 1, 1)


def _max_expr_tile_index_in_dir(expr_dir: Path) -> int:
    max_n = -1
    if not expr_dir.is_dir():
        return max_n
    for p in expr_dir.iterdir():
        if not _is_gallery_image_file(p):
            continue
        n = _expr_tile_index_from_stem(p.stem)
        if n is not None:
            max_n = max(max_n, n)
    return max_n


def _next_expr_tile_index_for_new_tile(expr_dir: Path) -> int:
    return max(_max_expr_tile_index_in_dir(expr_dir) + 1, 1)


def _last_camera_angle_id_in_stem(stem: str) -> int | None:
    last: int | None = None
    for m in re.finditer(r"_angle_(\d{3})", stem, flags=re.I):
        last = int(m.group(1))
    return last


def _camera_angle_id_for_listing(stem: str) -> int:
    x = _last_camera_angle_id_in_stem(stem)
    return x if x is not None else 0


def _pose_gallery_basename_sort_key(name: str) -> tuple[Any, ...]:
    stem = Path(name).stem.lower()
    if stem == "pose_000":
        return (0, 0, "", stem)
    m = re.match(r"^pose_(\d{3})(.*)$", stem)
    if m:
        return (1, int(m.group(1)), m.group(2) or "", stem)
    if stem.startswith("angle_"):
        m2 = re.match(r"^angle_(\d+)", stem)
        aid = int(m2.group(1)) if m2 else 0
        return (2, aid, stem, stem)
    return (3, 0, stem, stem)


def _expr_gallery_basename_sort_key(name: str) -> tuple[Any, ...]:
    stem = Path(name).stem.lower()
    if stem == "expr_000":
        return (0, 0, "", stem)
    m = re.match(r"^expr_(\d{3})(.*)$", stem)
    if m:
        return (1, int(m.group(1)), m.group(2) or "", stem)
    if stem.startswith("angle_"):
        m2 = re.match(r"^angle_(\d+)", stem)
        aid = int(m2.group(1)) if m2 else 0
        return (2, aid, stem, stem)
    return (3, 0, stem, stem)


def _next_edit_suffix_index(folder: Path, stem: str) -> int:
    """Next ``k`` for ``{stem}_edit_{k:03d}``; accounts for legacy ``_edited_`` siblings."""
    prefix = f"{stem}_edit_"
    max_k = -1
    if folder.is_dir():
        for p in folder.iterdir():
            if not p.is_file():
                continue
            s = p.stem
            leg = f"{stem}_edited_"
            if s.startswith(prefix):
                rest = s[len(prefix) :]
                m = re.match(r"^(\d{3})", rest)
                if m:
                    max_k = max(max_k, int(m.group(1)))
            elif s.startswith(leg):
                rest = s[len(leg) :]
                m = re.match(r"^(\d+)", rest)
                if m:
                    max_k = max(max_k, int(m.group(1)))
    return max_k + 1


def _abs_to_storage_rel(abs_path: Path) -> str:
    return str(abs_path.resolve().relative_to(DEFAULT_STORAGE_ROOT.resolve())).replace("\\", "/")


def resolve_storage_rel_path_to_abs(rel: str) -> Path:
    """Resolve a path relative to DEFAULT_STORAGE_ROOT (same contract as UI ``resolve_storage_rel_file`` without requiring the file to exist)."""
    rel_norm = str(rel).replace("\\", "/").lstrip("/")
    target = (DEFAULT_STORAGE_ROOT / rel_norm).resolve()
    root = DEFAULT_STORAGE_ROOT.resolve()
    if root != target and root not in target.parents:
        raise ValueError("Storage-relative path escapes root")
    return target


def _abs_to_char_rel(char_key: str, abs_path: Path) -> str:
    """Path relative to the character's folder (no ``<char_key>/`` prefix).

    The character key is the one source of truth - it lives on the folder name,
    not inside stored JSON. Use :func:`resolve_char_rel_path_to_abs` to reverse.
    """
    char_dir = get_character_paths(char_key).character_dir.resolve()
    return str(abs_path.resolve().relative_to(char_dir)).replace("\\", "/")


def resolve_char_rel_path_to_abs(char_key: str, rel: str) -> Path:
    """Resolve a character-relative path under ``<char_dir>/<rel>`` with escape check."""
    char_dir = get_character_paths(char_key).character_dir.resolve()
    rel_norm = str(rel).replace("\\", "/").lstrip("/")
    target = (char_dir / rel_norm).resolve()
    if char_dir != target and char_dir not in target.parents:
        raise ValueError("Character-relative path escapes character folder")
    return target


def _strip_char_key_prefix(char_key: str, rel: str) -> str:
    """If ``rel`` is storage-relative (starts with ``<char_key>/``) return the
    character-relative suffix; otherwise return ``rel`` unchanged. Accepts either
    forward or backward slashes on input.
    """
    s = str(rel).replace("\\", "/").lstrip("/")
    prefix = f"{char_key}/"
    if s.startswith(prefix):
        return s[len(prefix) :]
    return s


def _prefix_char_key(char_key: str, rel: str) -> str:
    """Inverse of :func:`_strip_char_key_prefix`: guarantee a ``<char_key>/``-prefixed
    storage-relative path. If ``rel`` already starts with ``<char_key>/`` it is
    returned unchanged (normalized to forward slashes).
    """
    s = str(rel).replace("\\", "/").lstrip("/")
    if not s:
        return s
    prefix = f"{char_key}/"
    if s.startswith(prefix):
        return s
    return prefix + s


# First path segment allowed for character-relative JSON under a character folder.
_CHAR_REL_ALLOWED_FIRST_SEGMENTS = frozenset(
    ("sequence", "poses", "expressions", "dataset", ".pose_references")
)


def _expand_rel_to_storage_rel(char_key: str, rel: str) -> str:
    """Expand a path under ``char_key`` to storage-relative ``<char_key>/suffix``.

    Peels stale leading segments (e.g. old folder name ``h`` in ``h/sequence/...``)
    until the remainder starts with ``char_key/`` or a known char-relative root, so
    we never produce ``<char_key>/<wrong>/...`` when expanding for the API.

    A single-segment stale value (e.g. ``h`` with no slash) is not corrected here;
    use :func:`repair_character_stored_paths` for that case.
    """
    r = str(rel).replace("\\", "/").lstrip("/")
    if not r:
        return r
    prefix = f"{char_key}/"
    if r.startswith(prefix):
        return r
    allowed = _CHAR_REL_ALLOWED_FIRST_SEGMENTS
    max_peel = 5
    for _ in range(max_peel):
        if "/" not in r:
            break
        first, _, rest = r.partition("/")
        if first == char_key or first in allowed:
            break
        r = rest
    return prefix + r


def pose_flat_gallery_item_id(folder_key: str, rel_norm: str) -> str:
    return f"pimg:{folder_key}:{rel_norm.replace(chr(92), '/').lstrip('/')}"


def expr_flat_gallery_item_id(folder_key: str, rel_norm: str) -> str:
    return f"eimg:{folder_key}:{rel_norm.replace(chr(92), '/').lstrip('/')}"


def parse_pose_flat_gallery_item_id(item_id: str) -> tuple[str, str] | None:
    if not item_id.startswith("pimg:"):
        return None
    rest = item_id[5:]
    idx = rest.find(":")
    if idx < 0:
        return None
    return rest[:idx], rest[idx + 1 :]


def parse_expr_flat_gallery_item_id(item_id: str) -> tuple[str, str] | None:
    if not item_id.startswith("eimg:"):
        return None
    rest = item_id[5:]
    idx = rest.find(":")
    if idx < 0:
        return None
    return rest[:idx], rest[idx + 1 :]


def _lift_one_multi_angle_folder(folder: Path) -> None:
    """Move ``<folder_name>_multi_angle/*`` into ``folder``."""
    if not folder.is_dir():
        return
    multi = folder / f"{folder.name}_multi_angle"
    if not multi.is_dir():
        return
    for f in list(multi.iterdir()):
        if f.name == "order.json":
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass
            continue
        if not f.is_file():
            continue
        dest = folder / f.name
        if dest.exists():
            try:
                if dest.resolve() == f.resolve():
                    continue
            except OSError:
                pass
            stem, suf = f.stem, f.suffix
            n = 1
            while True:
                cand = folder / f"{stem}_moved{n}{suf}"
                if not cand.exists():
                    dest = cand
                    break
                n += 1
        shutil.move(str(f), str(dest))
    try:
        multi.rmdir()
    except OSError:
        pass


def lift_pose_and_expression_multi_angle_dirs(char_key: str) -> None:
    character = get_character_paths(char_key)
    if character.poses_dir.exists():
        for pdir in character.poses_dir.iterdir():
            if pdir.is_dir():
                _lift_one_multi_angle_folder(pdir)
    if character.expressions_dir.exists():
        for edir in character.expressions_dir.iterdir():
            if edir.is_dir():
                _lift_one_multi_angle_folder(edir)


def _pose_gallery_root_image_paths(char_key: str) -> list[Path]:
    character = get_character_paths(char_key)
    root = character.poses_dir
    if not root.is_dir():
        return []
    _migrate_flat_pose_starting_image_to_pose_000_if_needed(root)
    return [
        p
        for p in root.iterdir()
        if _is_gallery_image_file(p) and not _is_flat_pose_starting_image_filename(p.name)
    ]


def _expression_gallery_root_image_paths(char_key: str) -> list[Path]:
    character = get_character_paths(char_key)
    root = character.expressions_dir
    if not root.is_dir():
        return []
    return [p for p in root.iterdir() if _is_gallery_image_file(p)]


def _ordered_pose_root_image_abs_paths(char_key: str) -> list[Path]:
    character = get_character_paths(char_key)
    root = character.poses_dir
    files = _pose_gallery_root_image_paths(char_key)
    if not files:
        return []
    angle0 = _find_first_matching_image(root, POSE_GALLERY_BASE_STEM)
    if angle0 is not None:
        base = angle0
    else:
        base = sorted(files, key=lambda x: _pose_gallery_basename_sort_key(x.name))[0]
    seen = {str(base.resolve())}
    out: list[Path] = [base]
    rest = [p for p in files if str(p.resolve()) not in seen]
    rest.sort(key=lambda x: _pose_gallery_basename_sort_key(x.name))
    out.extend(rest)
    return out


def _ordered_expression_root_image_abs_paths(char_key: str) -> list[Path]:
    character = get_character_paths(char_key)
    root = character.expressions_dir
    files = _expression_gallery_root_image_paths(char_key)
    if not files:
        return []
    angle0 = _find_first_matching_image(root, EXPR_GALLERY_BASE_STEM)
    starting = _find_first_matching_image(root, "starting_image")
    base = angle0 if angle0 is not None else starting
    if base is None:
        return sorted(files, key=lambda x: _expr_gallery_basename_sort_key(x.name))
    seen = {str(base.resolve())}
    out: list[Path] = [base]
    rest = [p for p in files if str(p.resolve()) not in seen]
    rest.sort(key=lambda x: _expr_gallery_basename_sort_key(x.name))
    out.extend(rest)
    return out


def _ordered_pose_folder_image_abs_paths(char_key: str, folder_key: str) -> list[Path]:
    _ = folder_key
    return _ordered_pose_root_image_abs_paths(char_key)


def _ordered_expression_folder_image_abs_paths(char_key: str, folder_key: str) -> list[Path]:
    _ = folder_key
    return _ordered_expression_root_image_abs_paths(char_key)


def all_pose_flat_gallery_item_ids(char_key: str) -> dict[str, tuple[str, str]]:
    """item_id -> (bucket_key, storage_rel)."""
    out: dict[str, tuple[str, str]] = {}
    for abs_p in _pose_gallery_root_image_paths(char_key):
        rel = _abs_to_storage_rel(abs_p)
        iid = pose_flat_gallery_item_id(POSE_FLAT_BUCKET, rel)
        out[iid] = (POSE_FLAT_BUCKET, rel)
    return out


def all_expression_flat_gallery_item_ids(char_key: str) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    for abs_p in _expression_gallery_root_image_paths(char_key):
        rel = _abs_to_storage_rel(abs_p)
        iid = expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, rel)
        out[iid] = (EXPR_FLAT_BUCKET, rel)
    return out


def _sync_pose_image_order_with_disk(
    char_key: str,
    st: dict[str, Any],
    *,
    on_disk: dict[str, tuple[str, str]] | None = None,
) -> list[str]:
    if on_disk is None:
        on_disk = all_pose_flat_gallery_item_ids(char_key)
    raw_order = [str(x).strip() for x in (st.get(POSE_IMAGE_ORDER) or []) if str(x).strip()]
    order = [i for i in raw_order if i in on_disk]
    seen = set(order)
    for abs_p in _ordered_pose_root_image_abs_paths(char_key):
        rel = _abs_to_storage_rel(abs_p)
        iid = pose_flat_gallery_item_id(POSE_FLAT_BUCKET, rel)
        if iid not in seen:
            order.append(iid)
            seen.add(iid)
    for iid in on_disk:
        if iid not in seen:
            order.append(iid)
            seen.add(iid)
    return order


def _sync_expression_image_order_with_disk(
    char_key: str,
    st: dict[str, Any],
    *,
    on_disk: dict[str, tuple[str, str]] | None = None,
) -> list[str]:
    if on_disk is None:
        on_disk = all_expression_flat_gallery_item_ids(char_key)
    raw_order = [str(x).strip() for x in (st.get(EXPR_IMAGE_ORDER) or []) if str(x).strip()]
    order = [i for i in raw_order if i in on_disk]
    seen = set(order)
    for abs_p in _ordered_expression_root_image_abs_paths(char_key):
        rel = _abs_to_storage_rel(abs_p)
        iid = expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, rel)
        if iid not in seen:
            order.append(iid)
            seen.add(iid)
    for iid in on_disk:
        if iid not in seen:
            order.append(iid)
            seen.add(iid)
    return order


def _allocate_flat_gallery_dest_basename(
    root: Path,
    folder_key: str,
    src: Path,
    occupied: set[str],
) -> str:
    """Pick a unique basename under ``root`` when lifting from a legacy subfolder."""
    name = src.name
    lower = name.lower()
    if lower.startswith("starting_image."):
        aid = _next_angle_id_for_gallery_folder(root)
        stem = f"angle_{aid:03d}_{sanitize_for_folder(folder_key, max_len=40)}_start"
        return f"{stem}{src.suffix.lower() or '.png'}"
    if name not in occupied:
        return name
    stem, suf = src.stem, src.suffix or ".png"
    aid = _next_angle_id_for_gallery_folder(root)
    return f"angle_{aid:03d}_{unique_suffix(4)}{suf}"


def _lift_gallery_subfolders_to_root(
    char_key: str,
    *,
    kind: str,
    folder_order_hint: list[str],
) -> dict[str, str]:
    """
    Move ``poses/<sub>/`` or ``expressions/<sub>/`` gallery files into the parent root.

    Returns mapping old storage-relative path -> new storage-relative path.
    """
    character = get_character_paths(char_key)
    base_dir = character.poses_dir if kind == "poses" else character.expressions_dir
    ensure_dirs(base_dir)
    occupied = {
        p.name
        for p in base_dir.iterdir()
        if p.is_file() and _is_gallery_image_file(p)
    }
    rel_map: dict[str, str] = {}
    subdirs = [p for p in base_dir.iterdir() if p.is_dir()]
    if not subdirs:
        return rel_map

    order_names = [x for x in folder_order_hint if any(d.name == x for d in subdirs)]
    seen_n = set(order_names)
    for d in sorted(subdirs, key=lambda x: x.name.lower()):
        if d.name not in seen_n:
            order_names.append(d.name)
            seen_n.add(d.name)

    for d in order_names:
        sub = base_dir / d
        if not sub.is_dir():
            continue
        files = sorted(
            [p for p in sub.iterdir() if _is_gallery_image_file(p)],
            key=lambda x: x.name.lower(),
        )
        for src in files:
            old_rel = _abs_to_storage_rel(src)
            dest_name = _allocate_flat_gallery_dest_basename(base_dir, d, src, occupied)
            while dest_name in occupied:
                stem, suf = Path(dest_name).stem, Path(dest_name).suffix or ".png"
                aid = _next_angle_id_for_gallery_folder(base_dir)
                dest_name = f"angle_{aid:03d}_{unique_suffix(4)}{suf}"
            dest = base_dir / dest_name
            shutil.move(str(src), str(dest))
            occupied.add(dest_name)
            rel_map[old_rel] = _abs_to_storage_rel(dest)
        _lift_one_multi_angle_folder(sub)
        try:
            for leftover in list(sub.iterdir()):
                if leftover.is_file():
                    leftover.unlink(missing_ok=True)
            sub.rmdir()
        except OSError:
            pass
    return rel_map


def _remap_pose_gallery_item_id_to_flat(iid: str, rel_map: dict[str, str]) -> str:
    p = parse_pose_flat_gallery_item_id(iid)
    if not p:
        return iid
    _fk, rel = p
    new_rel = rel_map.get(rel, rel)
    return pose_flat_gallery_item_id(POSE_FLAT_BUCKET, new_rel)


def _remap_expr_gallery_item_id_to_flat(iid: str, rel_map: dict[str, str]) -> str:
    p = parse_expr_flat_gallery_item_id(iid)
    if not p:
        return iid
    _fk, rel = p
    new_rel = rel_map.get(rel, rel)
    return expr_flat_gallery_item_id(EXPR_FLAT_BUCKET, new_rel)


def _reb_pose_builder_tile_id_to_flat(tile_id: str) -> str:
    s = str(tile_id)
    if not s.startswith("pose:"):
        return s
    parts = s.split(":", 3)
    if len(parts) >= 4 and parts[2] == "angle":
        return f"pose:{POSE_FLAT_BUCKET}:angle:{parts[3]}"
    if len(parts) == 2:
        return f"pose:{POSE_FLAT_BUCKET}"
    return s


def _reb_expr_builder_tile_id_to_flat(tile_id: str) -> str:
    s = str(tile_id)
    if not s.startswith("expr:"):
        return s
    parts = s.split(":", 3)
    if len(parts) >= 4 and parts[2] == "angle":
        return f"expr:{EXPR_FLAT_BUCKET}:angle:{parts[3]}"
    if len(parts) == 2:
        return f"expr:{EXPR_FLAT_BUCKET}"
    return s


def lift_gallery_layout_v2(char_key: str) -> None:
    """Flatten ``poses/*`` / ``expressions/*`` subfolders; rewrite gallery item ids to ``flat`` bucket."""
    path = _gallery_ui_state_path(char_key)
    st = read_gallery_ui_state(char_key)
    pose_hint = list(st.get(POSE_KEY_ORDER) or [])
    expr_hint = list(st.get(EXPR_KEY_ORDER) or [])
    pose_map = _lift_gallery_subfolders_to_root(char_key, kind="poses", folder_order_hint=pose_hint)
    expr_map = _lift_gallery_subfolders_to_root(
        char_key, kind="expressions", folder_order_hint=expr_hint
    )

    def remap_pose_list(xs: list[Any]) -> list[str]:
        return [_remap_pose_gallery_item_id_to_flat(str(x), pose_map) for x in xs]

    def remap_expr_list(xs: list[Any]) -> list[str]:
        return [_remap_expr_gallery_item_id_to_flat(str(x), expr_map) for x in xs]

    st[POSE_IMAGE_ORDER] = remap_pose_list(st.get(POSE_IMAGE_ORDER) or [])
    st[HIDDEN_POSE_IMAGES] = sorted(set(remap_pose_list(st.get(HIDDEN_POSE_IMAGES) or [])))
    st[EXPR_IMAGE_ORDER] = remap_expr_list(st.get(EXPR_IMAGE_ORDER) or [])
    st[HIDDEN_EXPR_IMAGES] = sorted(set(remap_expr_list(st.get(HIDDEN_EXPR_IMAGES) or [])))
    st[POSE_KEY_ORDER] = [POSE_FLAT_BUCKET] if _pose_gallery_root_image_paths(char_key) else []
    st["hidden_pose_keys"] = []
    st[EXPR_KEY_ORDER] = [EXPR_FLAT_BUCKET] if _expression_gallery_root_image_paths(char_key) else []
    st["hidden_expression_keys"] = []
    st["dataset_builder_order"] = [
        _reb_pose_builder_tile_id_to_flat(x)
        if str(x).startswith("pose:")
        else _reb_expr_builder_tile_id_to_flat(x)
        if str(x).startswith("expr:")
        else x
        for x in (st.get("dataset_builder_order") or [])
    ]
    st["dataset_builder_pose_strip_ids"] = [
        _reb_pose_builder_tile_id_to_flat(x) for x in (st.get("dataset_builder_pose_strip_ids") or [])
    ]
    st["dataset_builder_expr_strip_ids"] = [
        _reb_expr_builder_tile_id_to_flat(x) for x in (st.get("dataset_builder_expr_strip_ids") or [])
    ]
    st[GALLERY_LAYOUT_V2] = True
    on_p = all_pose_flat_gallery_item_ids(char_key)
    on_e = all_expression_flat_gallery_item_ids(char_key)
    st[POSE_IMAGE_ORDER] = _sync_pose_image_order_with_disk(char_key, st, on_disk=on_p)
    st[EXPR_IMAGE_ORDER] = _sync_expression_image_order_with_disk(char_key, st, on_disk=on_e)
    write_gallery_ui_state(char_key, st)


def _run_gallery_flat_migrated_v1(char_key: str, st: dict[str, Any]) -> dict[str, Any]:
    lift_pose_and_expression_multi_angle_dirs(char_key)

    def legacy_scan_poses() -> dict[str, str]:
        character = get_character_paths(char_key)
        out: dict[str, str] = {}
        if not character.poses_dir.exists():
            return out
        for pdir in character.poses_dir.iterdir():
            if not pdir.is_dir():
                continue
            starting = _find_first_matching_image(pdir, "starting_image")
            if starting:
                out[pdir.name] = str(starting)
        return out

    def legacy_scan_expr() -> dict[str, str]:
        character = get_character_paths(char_key)
        out: dict[str, str] = {}
        if not character.expressions_dir.exists():
            return out
        for edir in character.expressions_dir.iterdir():
            if not edir.is_dir():
                continue
            starting = _find_first_matching_image(edir, "starting_image")
            if starting:
                out[edir.name] = str(starting)
        return out

    paths_pose = legacy_scan_poses()
    paths_expr = legacy_scan_expr()
    pose_order_keys, _ = _resolve_pose_display_order_legacy(paths_pose, st)
    expr_order_keys, _ = _resolve_expression_display_order(paths_expr, st)

    hidden_pose_folders = set(st.get("hidden_pose_keys") or [])
    hidden_expr_folders = set(st.get("hidden_expression_keys") or [])

    def ordered_in_folder_pose(fk: str) -> list[Path]:
        character = get_character_paths(char_key)
        pose_dir = character.pose_dir(fk)
        if not pose_dir.is_dir():
            return []
        starting = _find_first_matching_image(pose_dir, "starting_image")
        if starting is None:
            return []
        angle0 = _find_first_matching_image(
            pose_dir, POSE_GALLERY_BASE_STEM
        ) or _find_first_matching_image(pose_dir, "angle_000")
        base = angle0 if angle0 is not None else starting
        out: list[Path] = [base]
        seen: set[str] = {str(base.resolve())}
        root_candidates = [
            p for p in pose_dir.iterdir() if _is_gallery_image_file(p) and p.resolve() != base.resolve()
        ]
        root_candidates.sort(key=lambda x: x.name.lower())
        for p in root_candidates:
            k = str(p.resolve())
            if k not in seen:
                out.append(p)
                seen.add(k)
        return out

    def ordered_in_folder_expr(fk: str) -> list[Path]:
        character = get_character_paths(char_key)
        expr_dir = character.expression_dir(fk)
        if not expr_dir.is_dir():
            return []
        starting = _find_first_matching_image(expr_dir, "starting_image")
        if starting is None:
            return []
        angle0 = _find_first_matching_image(
            expr_dir, EXPR_GALLERY_BASE_STEM
        ) or _find_first_matching_image(expr_dir, "angle_000")
        base = angle0 if angle0 is not None else starting
        out: list[Path] = [base]
        seen: set[str] = {str(base.resolve())}
        root_candidates = [
            p for p in expr_dir.iterdir() if _is_gallery_image_file(p) and p.resolve() != base.resolve()
        ]
        root_candidates.sort(key=lambda x: x.name.lower())
        for p in root_candidates:
            k = str(p.resolve())
            if k not in seen:
                out.append(p)
                seen.add(k)
        return out

    pose_img_order: list[str] = []
    hidden_pose_imgs: list[str] = []
    for fk in pose_order_keys:
        if fk not in paths_pose:
            continue
        for abs_p in ordered_in_folder_pose(fk):
            rel = _abs_to_storage_rel(abs_p)
            iid = pose_flat_gallery_item_id(fk, rel)
            pose_img_order.append(iid)
            if fk in hidden_pose_folders:
                hidden_pose_imgs.append(iid)

    expr_img_order: list[str] = []
    hidden_expr_imgs: list[str] = []
    for fk in expr_order_keys:
        if fk not in paths_expr:
            continue
        for abs_p in ordered_in_folder_expr(fk):
            rel = _abs_to_storage_rel(abs_p)
            iid = expr_flat_gallery_item_id(fk, rel)
            expr_img_order.append(iid)
            if fk in hidden_expr_folders:
                hidden_expr_imgs.append(iid)

    st[POSE_IMAGE_ORDER] = pose_img_order
    st[HIDDEN_POSE_IMAGES] = sorted(set(hidden_pose_imgs))
    st[EXPR_IMAGE_ORDER] = expr_img_order
    st[HIDDEN_EXPR_IMAGES] = sorted(set(hidden_expr_imgs))
    st[GALLERY_FLAT_MIGRATED_V1] = True
    return st


def ensure_gallery_flat_migrated(char_key: str) -> None:
    path = _gallery_ui_state_path(char_key)
    st: dict[str, Any]
    if path.is_file():
        try:
            with open(path, encoding="utf-8") as f:
                st = json.load(f)
        except Exception:
            st = {}
    else:
        st = {}
    if not st.get(GALLERY_FLAT_MIGRATED_V1):
        st = _run_gallery_flat_migrated_v1(char_key, st)
        ensure_dirs(path.parent)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(st, f, indent=2)
        st = read_gallery_ui_state(char_key)
    if not st.get(GALLERY_LAYOUT_V2):
        lift_gallery_layout_v2(char_key)
    migrate_gallery_filenames_v3(char_key)


def _rewrite_pose_rel_for_folder_rename(rel: str, old_key: str, new_key: str) -> str:
    parts = rel.replace("\\", "/").split("/")
    for i in range(len(parts) - 1):
        if parts[i] == "poses" and parts[i + 1] == old_key:
            parts[i + 1] = new_key
            return "/".join(parts)
    return rel


def _rewrite_expression_rel_for_folder_rename(rel: str, old_key: str, new_key: str) -> str:
    parts = rel.replace("\\", "/").split("/")
    for i in range(len(parts) - 1):
        if parts[i] == "expressions" and parts[i + 1] == old_key:
            parts[i + 1] = new_key
            return "/".join(parts)
    return rel


def _remap_pose_item_id(item_id: str, old_key: str, new_key: str) -> str:
    p = parse_pose_flat_gallery_item_id(item_id)
    if not p:
        return item_id
    fk, rel = p
    if fk != old_key:
        return item_id
    rel2 = _rewrite_pose_rel_for_folder_rename(rel, old_key, new_key)
    return pose_flat_gallery_item_id(new_key, rel2)


def _remap_expr_item_id(item_id: str, old_key: str, new_key: str) -> str:
    p = parse_expr_flat_gallery_item_id(item_id)
    if not p:
        return item_id
    fk, rel = p
    if fk != old_key:
        return item_id
    rel2 = _rewrite_expression_rel_for_folder_rename(rel, old_key, new_key)
    return expr_flat_gallery_item_id(new_key, rel2)


def _reb_pose_builder_tile_id(tile_id: str, old_key: str, new_key: str) -> str:
    s = str(tile_id)
    if s == f"pose:{old_key}":
        return f"pose:{new_key}"
    prefix = f"pose:{old_key}:angle:"
    if s.startswith(prefix):
        return f"pose:{new_key}:angle:" + s[len(prefix) :]
    return s


def _reb_expr_builder_tile_id(tile_id: str, old_key: str, new_key: str) -> str:
    s = str(tile_id)
    if s == f"expr:{old_key}":
        return f"expr:{new_key}"
    prefix = f"expr:{old_key}:angle:"
    if s.startswith(prefix):
        return f"expr:{new_key}:angle:" + s[len(prefix) :]
    return s


def append_pose_image_ids_to_order(char_key: str, item_ids: list[str]) -> None:
    if not item_ids:
        return
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    order = _sync_pose_image_order_with_disk(char_key, st)
    seen = set(order)
    for iid in item_ids:
        if iid in seen:
            order.remove(iid)
        order.append(iid)
        seen.add(iid)
    st[POSE_IMAGE_ORDER] = order
    write_gallery_ui_state(char_key, st)


def append_expression_image_ids_to_order(char_key: str, item_ids: list[str]) -> None:
    if not item_ids:
        return
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    order = _sync_expression_image_order_with_disk(char_key, st)
    seen = set(order)
    for iid in item_ids:
        if iid in seen:
            order.remove(iid)
        order.append(iid)
        seen.add(iid)
    st[EXPR_IMAGE_ORDER] = order
    write_gallery_ui_state(char_key, st)


def insert_pose_image_ids_after_item(char_key: str, after_item_id: str | None, new_ids: list[str]) -> None:
    if not new_ids:
        return
    ensure_gallery_flat_migrated(char_key)
    path = _gallery_ui_state_path(char_key)
    with open(path, encoding="utf-8") as f:
        st = json.load(f)
    order = _sync_pose_image_order_with_disk(char_key, st)
    for iid in new_ids:
        if iid in order:
            order.remove(iid)
    if after_item_id and after_item_id in order:
        idx = order.index(after_item_id) + 1
        order[idx:idx] = new_ids
    else:
        order.extend(new_ids)
    st[POSE_IMAGE_ORDER] = order
    with open(path, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=2)


def insert_expression_image_ids_after_item(
    char_key: str, after_item_id: str | None, new_ids: list[str]
) -> None:
    if not new_ids:
        return
    ensure_gallery_flat_migrated(char_key)
    path = _gallery_ui_state_path(char_key)
    with open(path, encoding="utf-8") as f:
        st = json.load(f)
    order = _sync_expression_image_order_with_disk(char_key, st)
    for iid in new_ids:
        if iid in order:
            order.remove(iid)
    if after_item_id and after_item_id in order:
        idx = order.index(after_item_id) + 1
        order[idx:idx] = new_ids
    else:
        order.extend(new_ids)
    st[EXPR_IMAGE_ORDER] = order
    with open(path, encoding="utf-8") as f:
        json.dump(st, f, indent=2)


def _transform_flat_gallery_id_list(
    ids: list[Any], transform: Callable[[str], str]
) -> tuple[list[Any], int]:
    """Apply ``transform(rel) -> rel'`` to the rel portion of every parseable
    ``pimg:`` / ``eimg:`` id in ``ids``. Returns ``(new_ids, changed_count)``.
    """
    out: list[Any] = []
    changed = 0
    for iid in ids:
        if not isinstance(iid, str):
            out.append(iid)
            continue
        parsed: tuple[str, str] | None
        builder: Callable[[str, str], str] | None = None
        p = parse_pose_flat_gallery_item_id(iid)
        if p is not None:
            parsed = p
            builder = pose_flat_gallery_item_id
        else:
            e = parse_expr_flat_gallery_item_id(iid)
            if e is not None:
                parsed = e
                builder = expr_flat_gallery_item_id
            else:
                parsed = None
        if parsed is None or builder is None:
            out.append(iid)
            continue
        bucket, rel = parsed
        new_rel = transform(rel)
        if new_rel != rel:
            out.append(builder(bucket, new_rel))
            changed += 1
        else:
            out.append(iid)
    return out, changed


def _normalize_gallery_ui_state_flat_ids(
    state: dict[str, Any], transform: Callable[[str], str]
) -> int:
    """Apply ``transform`` to every flat-id list field in ``state`` in place."""
    total = 0
    for field in _GALLERY_UI_STATE_FLAT_ID_FIELDS:
        lst = state.get(field)
        if not isinstance(lst, list):
            continue
        new_list, changed = _transform_flat_gallery_id_list(lst, transform)
        if changed:
            state[field] = new_list
            total += changed
    return total


def read_gallery_ui_state(char_key: str) -> dict[str, Any]:
    """Load gallery UI state and return flat ids in storage-relative form.

    Stored on disk as character-relative (flat id rel has no ``<char_key>/`` prefix)
    so the character folder is the single source of truth. Legacy rows with
    storage-relative rels are migrated on first read.
    """
    defaults: dict[str, Any] = {
        "hidden_pose_keys": [],
        "hidden_expression_keys": [],
        POSE_KEY_ORDER: [],
        EXPR_KEY_ORDER: [],
        POSE_IMAGE_ORDER: [],
        HIDDEN_POSE_IMAGES: [],
        EXPR_IMAGE_ORDER: [],
        HIDDEN_EXPR_IMAGES: [],
        GALLERY_FLAT_MIGRATED_V1: False,
        GALLERY_LAYOUT_V2: False,
        GALLERY_FILENAME_V3: False,
        "dataset_builder_order": [],
        "dataset_builder_pose_strip_ids": [],
        "dataset_builder_expr_strip_ids": [],
    }
    path = _gallery_ui_state_path(char_key)
    if not path.is_file():
        return dict(defaults)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        out = dict(defaults)
        out.update(data)
        out["hidden_pose_keys"] = list(data.get("hidden_pose_keys", []))
        out["hidden_expression_keys"] = list(data.get("hidden_expression_keys", []))
        out[POSE_KEY_ORDER] = list(data.get(POSE_KEY_ORDER, []))
        out[EXPR_KEY_ORDER] = list(data.get(EXPR_KEY_ORDER, []))
        out[POSE_IMAGE_ORDER] = list(data.get(POSE_IMAGE_ORDER, []))
        out[HIDDEN_POSE_IMAGES] = list(data.get(HIDDEN_POSE_IMAGES, []))
        out[EXPR_IMAGE_ORDER] = list(data.get(EXPR_IMAGE_ORDER, []))
        out[HIDDEN_EXPR_IMAGES] = list(data.get(HIDDEN_EXPR_IMAGES, []))
        out[GALLERY_FLAT_MIGRATED_V1] = bool(data.get(GALLERY_FLAT_MIGRATED_V1, False))
        out[GALLERY_LAYOUT_V2] = bool(data.get(GALLERY_LAYOUT_V2, False))
        out[GALLERY_FILENAME_V3] = bool(data.get(GALLERY_FILENAME_V3, False))
        out["dataset_builder_order"] = list(data.get("dataset_builder_order", []))
        out["dataset_builder_pose_strip_ids"] = list(
            data.get("dataset_builder_pose_strip_ids", [])
        )
        out["dataset_builder_expr_strip_ids"] = list(
            data.get("dataset_builder_expr_strip_ids", [])
        )

        char_prefix = f"{char_key}/"

        def _strip_prefix(rel: str) -> str:
            r = rel.replace("\\", "/").lstrip("/")
            if r.startswith(char_prefix):
                return r[len(char_prefix) :]
            return r

        stripped = _normalize_gallery_ui_state_flat_ids(out, _strip_prefix)
        if stripped:
            try:
                with open(path, "w", encoding="utf-8") as wf:
                    json.dump(out, wf, indent=2)
            except OSError:
                pass

        def _expand_prefix(rel: str) -> str:
            return _expand_rel_to_storage_rel(char_key, rel)

        _normalize_gallery_ui_state_flat_ids(out, _expand_prefix)
        return out
    except Exception:
        return dict(defaults)


def write_gallery_ui_state(char_key: str, state: dict[str, Any]) -> None:
    path = _gallery_ui_state_path(char_key)
    ensure_dirs(path.parent)
    import copy

    to_persist = copy.deepcopy(state)
    char_prefix = f"{char_key}/"

    def _strip_prefix(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(char_prefix):
            return r[len(char_prefix) :]
        return r

    _normalize_gallery_ui_state_flat_ids(to_persist, _strip_prefix)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(to_persist, f, indent=2)


def _is_legacy_flat_gallery_filename(name: str) -> bool:
    stem_l = Path(name).stem.lower()
    nl = name.lower()
    if nl.startswith("angle_"):
        return True
    if "_edited_" in stem_l:
        return True
    if nl.startswith("starting_image"):
        return True
    return False


def _migrate_flat_gallery_root_basenames(root: Path, *, kind: str) -> dict[str, str]:
    """
    Rename legacy ``angle_*`` / ``*_edited_*`` / ``starting_image*`` files under a flat
    gallery root. Returns mapping old basename -> new basename for files that moved.
    """
    prefix = "pose" if kind == "pose" else "expr"
    base_stem = POSE_GALLERY_BASE_STEM if kind == "pose" else EXPR_GALLERY_BASE_STEM
    if not root.is_dir():
        return {}
    files = [p for p in root.iterdir() if _is_gallery_image_file(p)]
    to_migrate = [p for p in files if _is_legacy_flat_gallery_filename(p.name)]
    if not to_migrate:
        return {}

    edited_re = re.compile(r"^(.*)_edited_(\d+)$", re.I)
    primaries: list[Path] = []
    edited: list[Path] = []
    for p in to_migrate:
        if edited_re.match(p.stem):
            edited.append(p)
        else:
            primaries.append(p)

    def pkey(pa: Path) -> tuple:
        sl = pa.stem.lower()
        nl = pa.name.lower()
        if sl == "angle_000" or nl.startswith("angle_000."):
            return (0, "", pa.name.lower())
        if nl.startswith("starting_image"):
            return (1, pa.name.lower(), "")
        sk = (
            _pose_gallery_basename_sort_key(pa.name)
            if kind == "pose"
            else _expr_gallery_basename_sort_key(pa.name)
        )
        return (2, "", sk)

    primaries.sort(key=pkey)
    old_to_new_stem: dict[str, str] = {}
    name_map: dict[str, str] = {}
    next_idx = 1
    for p in primaries:
        ostem = p.stem
        olow = p.name.lower()
        if ostem.lower() == "angle_000" or olow.startswith("angle_000."):
            new_stem = base_stem
        else:
            new_stem = f"{prefix}_{next_idx:03d}"
            next_idx += 1
        old_to_new_stem[ostem] = new_stem
        ext = p.suffix.lower() or ".png"
        name_map[p.name] = f"{new_stem}{ext}"

    for p in edited:
        m = edited_re.match(p.stem)
        if not m:
            continue
        parent_stem = m.group(1)
        k = int(m.group(2))
        if parent_stem not in old_to_new_stem:
            ns = f"{prefix}_{next_idx:03d}"
            next_idx += 1
            old_to_new_stem[parent_stem] = ns
        nb_stem = old_to_new_stem[parent_stem] + f"_edit_{k:03d}"
        ext = p.suffix.lower() or ".png"
        name_map[p.name] = f"{nb_stem}{ext}"

    temp_paths: dict[str, Path] = {}
    for p in to_migrate:
        tmp = root / f".migr_{unique_suffix(8)}{p.suffix}"
        p.rename(tmp)
        temp_paths[p.name] = tmp
    for old_bn, new_bn in name_map.items():
        t = temp_paths[old_bn]
        dest = root / new_bn
        if dest.exists():
            dest.unlink(missing_ok=True)
        t.rename(dest)
    return name_map


def _apply_pose_expr_basename_map_to_ui_state(
    char_key: str, pose_bn: dict[str, str], expr_bn: dict[str, str]
) -> None:
    if not pose_bn and not expr_bn:
        return

    def repl_rel(rel: str) -> str:
        rel_norm = rel.replace("\\", "/").lstrip("/")
        parts = rel_norm.split("/")
        if len(parts) < 2:
            return rel_norm
        if parts[-2] == "poses" and parts[-1] in pose_bn:
            parts[-1] = pose_bn[parts[-1]]
            return "/".join(parts)
        if parts[-2] == "expressions" and parts[-1] in expr_bn:
            parts[-1] = expr_bn[parts[-1]]
            return "/".join(parts)
        return rel_norm

    def rem_pose_iid(iid: str) -> str:
        p = parse_pose_flat_gallery_item_id(iid)
        if not p:
            return iid
        fk, rel = p
        nr = repl_rel(rel)
        return pose_flat_gallery_item_id(fk, nr)

    def rem_expr_iid(iid: str) -> str:
        p = parse_expr_flat_gallery_item_id(iid)
        if not p:
            return iid
        fk, rel = p
        nr = repl_rel(rel)
        return expr_flat_gallery_item_id(fk, nr)

    def rem_builder_tile(tid: str) -> str:
        parts = str(tid).split(":")
        if len(parts) >= 4 and parts[0] == "pose" and parts[2] == "angle" and parts[3] in pose_bn:
            parts[3] = pose_bn[parts[3]]
            return ":".join(parts)
        if len(parts) >= 4 and parts[0] == "expr" and parts[2] == "angle" and parts[3] in expr_bn:
            parts[3] = expr_bn[parts[3]]
            return ":".join(parts)
        return tid

    st = read_gallery_ui_state(char_key)
    st[POSE_IMAGE_ORDER] = [rem_pose_iid(str(x)) for x in (st.get(POSE_IMAGE_ORDER) or [])]
    st[HIDDEN_POSE_IMAGES] = [rem_pose_iid(str(x)) for x in (st.get(HIDDEN_POSE_IMAGES) or [])]
    st[EXPR_IMAGE_ORDER] = [rem_expr_iid(str(x)) for x in (st.get(EXPR_IMAGE_ORDER) or [])]
    st[HIDDEN_EXPR_IMAGES] = [rem_expr_iid(str(x)) for x in (st.get(HIDDEN_EXPR_IMAGES) or [])]
    st["dataset_builder_order"] = [
        rem_builder_tile(str(x)) for x in (st.get("dataset_builder_order") or [])
    ]
    st["dataset_builder_pose_strip_ids"] = [
        rem_builder_tile(str(x)) for x in (st.get("dataset_builder_pose_strip_ids") or [])
    ]
    st["dataset_builder_expr_strip_ids"] = [
        rem_builder_tile(str(x)) for x in (st.get("dataset_builder_expr_strip_ids") or [])
    ]
    write_gallery_ui_state(char_key, st)
    st2 = read_gallery_ui_state(char_key)
    on_p = all_pose_flat_gallery_item_ids(char_key)
    on_e = all_expression_flat_gallery_item_ids(char_key)
    st2[POSE_IMAGE_ORDER] = _sync_pose_image_order_with_disk(char_key, st2, on_disk=on_p)
    st2[EXPR_IMAGE_ORDER] = _sync_expression_image_order_with_disk(char_key, st2, on_disk=on_e)
    write_gallery_ui_state(char_key, st2)


def migrate_gallery_filenames_v3(char_key: str) -> None:
    """Rename legacy flat-gallery filenames to ``pose_*`` / ``expr_*`` grammar; rewrite UI state."""
    st = read_gallery_ui_state(char_key)
    if st.get(GALLERY_FILENAME_V3):
        return
    character = get_character_paths(char_key)
    p_map = _migrate_flat_gallery_root_basenames(character.poses_dir, kind="pose")
    e_map = _migrate_flat_gallery_root_basenames(character.expressions_dir, kind="expr")
    if p_map or e_map:
        _apply_pose_expr_basename_map_to_ui_state(char_key, p_map, e_map)
    st_out = read_gallery_ui_state(char_key)
    st_out[GALLERY_FILENAME_V3] = True
    write_gallery_ui_state(char_key, st_out)


def set_pose_gallery_ui_state(char_key: str, order: list[str], hidden_keys: list[str]) -> None:
    """
    Set pose flat gallery: ``order`` is full list of ``pimg:`` item ids;
    ``hidden_keys`` lists hidden item ids.
    """
    ensure_gallery_flat_migrated(char_key)
    on_disk = all_pose_flat_gallery_item_ids(char_key)
    keys_on_disk = set(_scan_pose_gallery_paths(char_key).keys())
    st = read_gallery_ui_state(char_key)
    seen: set[str] = set()
    next_order: list[str] = []
    for iid in order or []:
        s = str(iid).strip()
        if s in on_disk and s not in seen:
            seen.add(s)
            next_order.append(s)
    for iid in on_disk:
        if iid not in seen:
            next_order.append(iid)
            seen.add(iid)
    hidden_set = {str(x).strip() for x in (hidden_keys or []) if str(x).strip() in on_disk}
    st[POSE_IMAGE_ORDER] = next_order
    st[HIDDEN_POSE_IMAGES] = sorted(hidden_set)
    folder_first: list[str] = []
    seen_f: set[str] = set()
    for iid in next_order:
        parsed = parse_pose_flat_gallery_item_id(iid)
        if not parsed:
            continue
        fk, _rel = parsed
        if fk not in seen_f:
            folder_first.append(fk)
            seen_f.add(fk)
    for k in _sync_gallery_order_list([], keys_on_disk):
        if k not in seen_f:
            folder_first.append(k)
            seen_f.add(k)
    st[POSE_KEY_ORDER] = folder_first
    st["hidden_pose_keys"] = []
    write_gallery_ui_state(char_key, st)


def set_expression_gallery_ui_state(char_key: str, order: list[str], hidden_keys: list[str]) -> None:
    """Set expression flat gallery: ``eimg:`` item ids and hidden item ids."""
    ensure_gallery_flat_migrated(char_key)
    on_disk = all_expression_flat_gallery_item_ids(char_key)
    keys_on_disk = set(_scan_expression_gallery_paths(char_key).keys())
    st = read_gallery_ui_state(char_key)
    seen: set[str] = set()
    next_order: list[str] = []
    for iid in order or []:
        s = str(iid).strip()
        if s in on_disk and s not in seen:
            seen.add(s)
            next_order.append(s)
    for iid in on_disk:
        if iid not in seen:
            next_order.append(iid)
            seen.add(iid)
    hidden_set = {str(x).strip() for x in (hidden_keys or []) if str(x).strip() in on_disk}
    st[EXPR_IMAGE_ORDER] = next_order
    st[HIDDEN_EXPR_IMAGES] = sorted(hidden_set)
    folder_first: list[str] = []
    seen_f: set[str] = set()
    for iid in next_order:
        parsed = parse_expr_flat_gallery_item_id(iid)
        if not parsed:
            continue
        fk, _rel = parsed
        if fk not in seen_f:
            folder_first.append(fk)
            seen_f.add(fk)
    for k in _sync_gallery_order_list([], keys_on_disk):
        if k not in seen_f:
            folder_first.append(k)
            seen_f.add(k)
    st[EXPR_KEY_ORDER] = folder_first
    st["hidden_expression_keys"] = []
    write_gallery_ui_state(char_key, st)


def set_dataset_builder_order(
    char_key: str,
    tile_ids: list[str],
    pose_strip_ids: list[str] | None = None,
    expr_strip_ids: list[str] | None = None,
) -> None:
    """
    Persist dataset-builder ordering (tileIds) into gallery_ui_state.json.

    Optional ``pose_strip_ids`` / ``expr_strip_ids`` define which visible tiles
    render under the Poses vs Expressions sections (cross-section drag).
    """
    st = read_gallery_ui_state(char_key)
    seen: set[str] = set()
    safe: list[str] = []
    for tid in tile_ids or []:
        s = str(tid).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        safe.append(s)
    st["dataset_builder_order"] = safe

    if pose_strip_ids is not None:
        ps: list[str] = []
        seen_p: set[str] = set()
        for tid in pose_strip_ids:
            s = str(tid).strip()
            if not s or s in seen_p:
                continue
            seen_p.add(s)
            ps.append(s)
        st["dataset_builder_pose_strip_ids"] = ps
    if expr_strip_ids is not None:
        es: list[str] = []
        seen_e: set[str] = set()
        for tid in expr_strip_ids:
            s = str(tid).strip()
            if not s or s in seen_e:
                continue
            seen_e.add(s)
            es.append(s)
        st["dataset_builder_expr_strip_ids"] = es

    write_gallery_ui_state(char_key, st)


def resolve_dataset_builder_strips(
    ordered: list[Any],
    st: dict[str, Any],
) -> tuple[list[str], list[str]]:
    """
    Return (pose_strip_ids, expr_strip_ids) for visible non-hidden builder tiles.

    ``ordered`` items are Pydantic models or dicts with ``tileId``, ``hidden``,
    ``sourceKind``.
    """
    visible_ids: list[str] = []
    by_id: dict[str, Any] = {}
    for it in ordered:
        tid = getattr(it, "tileId", None) or (it.get("tileId") if isinstance(it, dict) else None)
        if not tid:
            continue
        hidden = getattr(it, "hidden", False)
        if isinstance(it, dict):
            hidden = bool(it.get("hidden", False))
        if hidden:
            continue
        s = str(tid).strip()
        visible_ids.append(s)
        by_id[s] = it

    vis_set = set(visible_ids)
    ps_raw = [str(x).strip() for x in (st.get("dataset_builder_pose_strip_ids") or []) if str(x).strip()]
    es_raw = [str(x).strip() for x in (st.get("dataset_builder_expr_strip_ids") or []) if str(x).strip()]

    if not ps_raw and not es_raw:
        p: list[str] = []
        e: list[str] = []
        for it in ordered:
            tid = getattr(it, "tileId", None) or (it.get("tileId") if isinstance(it, dict) else None)
            if not tid:
                continue
            hidden = getattr(it, "hidden", False)
            if isinstance(it, dict):
                hidden = bool(it.get("hidden", False))
            if hidden:
                continue
            s = str(tid).strip()
            sk = getattr(it, "sourceKind", "") or (it.get("sourceKind", "") if isinstance(it, dict) else "")
            if sk == "expr":
                e.append(s)
            else:
                p.append(s)
        return p, e

    ps = [x for x in ps_raw if x in vis_set]
    es = [x for x in es_raw if x in vis_set]
    covered = set(ps) | set(es)
    for s in visible_ids:
        if s in covered:
            continue
        it = by_id.get(s)
        if it is None:
            continue
        sk = getattr(it, "sourceKind", "") or (it.get("sourceKind", "") if isinstance(it, dict) else "")
        if sk == "expr":
            es.append(s)
        else:
            ps.append(s)
    return ps, es


def apply_dataset_builder_order(
    char_key: str, tile_ids: list[str]
) -> list[str]:
    """
    Apply persisted dataset-builder order to an input list of tileIds.

    ``incoming`` defines default positions (e.g. each pose's angles right after
    that pose). Saved order is preserved for tiles that appear in the saved
    list; tiles not yet saved keep their relative positions from ``incoming``.
    """
    st = read_gallery_ui_state(char_key)
    saved = [str(x).strip() for x in (st.get("dataset_builder_order") or []) if str(x).strip()]
    saved_set = set(saved)
    incoming = [str(x).strip() for x in (tile_ids or []) if str(x).strip()]
    if not incoming:
        return []
    incoming_set = set(incoming)

    # Unique saved ids still present, in saved order (``saved`` should already be unique).
    sv: list[str] = []
    seen_sv: set[str] = set()
    for s in saved:
        if s in incoming_set and s not in seen_sv:
            sv.append(s)
            seen_sv.add(s)

    new_items = [t for t in incoming if t not in saved_set]
    pattern = [("S" if t in saved_set else "N") for t in incoming]
    s_count = sum(1 for k in pattern if k == "S")
    n_count = len(pattern) - s_count
    if s_count != len(sv) or n_count != len(new_items):
        out: list[str] = []
        for tid in saved:
            if tid in incoming_set:
                out.append(tid)
        appended = set(out)
        for tid in incoming:
            if tid not in appended:
                out.append(tid)
                appended.add(tid)
        return out

    si = iter(sv)
    ni = iter(new_items)
    return [next(si) if k == "S" else next(ni) for k in pattern]


_LEGACY_BASE_POSE_FOLDER = "base_00"


def _scan_pose_gallery_paths(char_key: str) -> dict[str, str]:
    files = _pose_gallery_root_image_paths(char_key)
    if not files:
        return {}
    ordered = _ordered_pose_root_image_abs_paths(char_key)
    anchor = str(ordered[0]) if ordered else str(files[0])
    return {POSE_FLAT_BUCKET: anchor}


def _scan_expression_gallery_paths(char_key: str) -> dict[str, str]:
    files = _expression_gallery_root_image_paths(char_key)
    if not files:
        return {}
    ordered = _ordered_expression_root_image_abs_paths(char_key)
    anchor = str(ordered[0]) if ordered else str(files[0])
    return {EXPR_FLAT_BUCKET: anchor}


def _sync_gallery_order_list(order: list[str], keys_on_disk: set[str]) -> list[str]:
    pruned = [k for k in order if k in keys_on_disk]
    existing = set(pruned)
    extra = sorted(keys_on_disk - existing)
    return pruned + extra


def _resolve_pose_display_order_legacy(
    paths: dict[str, str], st: dict[str, Any]
) -> tuple[list[str], bool]:
    keys = set(paths.keys())
    raw = list(st.get(POSE_KEY_ORDER) or [])
    if not raw:
        alpha = sorted(keys)
        if _LEGACY_BASE_POSE_FOLDER in keys:
            alpha = [k for k in alpha if k != _LEGACY_BASE_POSE_FOLDER]
            order = [_LEGACY_BASE_POSE_FOLDER] + alpha
        else:
            order = alpha
        return order, True
    order = _sync_gallery_order_list(raw, keys)
    return order, order != raw


def _resolve_pose_display_order(
    paths: dict[str, str], st: dict[str, Any]
) -> tuple[list[str], bool]:
    keys = set(paths.keys())
    raw = list(st.get(POSE_KEY_ORDER) or [])
    if not raw:
        return (sorted(keys), True) if keys else ([], True)
    order = _sync_gallery_order_list(raw, keys)
    return order, order != raw


def _resolve_expression_display_order(
    paths: dict[str, str], st: dict[str, Any]
) -> tuple[list[str], bool]:
    keys = set(paths.keys())
    raw = list(st.get(EXPR_KEY_ORDER) or [])
    if not raw:
        return sorted(keys), True
    order = _sync_gallery_order_list(raw, keys)
    return order, order != raw


def append_pose_keys_to_gallery_order_end(char_key: str, keys: list[str]) -> None:
    """Legacy no-op for folder keys; callers should use ``append_pose_image_ids_to_order``."""
    _ = keys
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    st[POSE_KEY_ORDER] = [POSE_FLAT_BUCKET] if _scan_pose_gallery_paths(char_key) else []
    st[POSE_IMAGE_ORDER] = _sync_pose_image_order_with_disk(char_key, st)
    write_gallery_ui_state(char_key, st)


def append_expression_keys_to_gallery_order_end(char_key: str, keys: list[str]) -> None:
    _ = keys
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    st[EXPR_KEY_ORDER] = [EXPR_FLAT_BUCKET] if _scan_expression_gallery_paths(char_key) else []
    st[EXPR_IMAGE_ORDER] = _sync_expression_image_order_with_disk(char_key, st)
    write_gallery_ui_state(char_key, st)


def _expand_pose_gallery_hide_targets(char_key: str, raw_ids: list[str]) -> list[str]:
    """``pimg:`` ids pass through; bare folder keys expand to all images in that folder."""
    on_disk = all_pose_flat_gallery_item_ids(char_key)
    out: list[str] = []
    for raw in raw_ids:
        s = str(raw).strip()
        if not s:
            continue
        if s.startswith("pimg:"):
            if s in on_disk:
                out.append(s)
            continue
        for iid in on_disk:
            pr = parse_pose_flat_gallery_item_id(iid)
            if pr and pr[0] == s:
                out.append(iid)
    return out


def _expand_expression_gallery_hide_targets(char_key: str, raw_ids: list[str]) -> list[str]:
    on_disk = all_expression_flat_gallery_item_ids(char_key)
    out: list[str] = []
    for raw in raw_ids:
        s = str(raw).strip()
        if not s:
            continue
        if s.startswith("eimg:"):
            if s in on_disk:
                out.append(s)
            continue
        for iid in on_disk:
            pr = parse_expr_flat_gallery_item_id(iid)
            if pr and pr[0] == s:
                out.append(iid)
    return out


def set_pose_gallery_hidden(char_key: str, item_ids: list[str], hidden: bool) -> None:
    ensure_gallery_flat_migrated(char_key)
    on_disk = all_pose_flat_gallery_item_ids(char_key)
    targets = _expand_pose_gallery_hide_targets(char_key, item_ids)
    st = read_gallery_ui_state(char_key)
    h = set(st.get(HIDDEN_POSE_IMAGES) or [])
    for iid in targets:
        if iid not in on_disk:
            continue
        if hidden:
            h.add(iid)
        else:
            h.discard(iid)
    st[HIDDEN_POSE_IMAGES] = sorted(h)
    write_gallery_ui_state(char_key, st)
    if not hidden:
        to_end = [x for x in targets if x in on_disk]
        if to_end:
            append_pose_image_ids_to_order(char_key, to_end)


def set_expression_gallery_hidden(char_key: str, item_ids: list[str], hidden: bool) -> None:
    ensure_gallery_flat_migrated(char_key)
    on_disk = all_expression_flat_gallery_item_ids(char_key)
    targets = _expand_expression_gallery_hide_targets(char_key, item_ids)
    st = read_gallery_ui_state(char_key)
    h = set(st.get(HIDDEN_EXPR_IMAGES) or [])
    for iid in targets:
        if iid not in on_disk:
            continue
        if hidden:
            h.add(iid)
        else:
            h.discard(iid)
    st[HIDDEN_EXPR_IMAGES] = sorted(h)
    write_gallery_ui_state(char_key, st)
    if not hidden:
        to_end = [x for x in targets if x in on_disk]
        if to_end:
            append_expression_image_ids_to_order(char_key, to_end)


def _pick_unique_pose_folder_key(
    character: Any, anchor_key: str, *, used_keys: set[str]
) -> str:
    base = sanitize_for_folder(f"{anchor_key}_edited", max_len=80)
    i = 0
    while True:
        cand = sanitize_for_folder(f"{base}_{i}", max_len=80)
        if cand not in used_keys and not character.pose_dir(cand).exists():
            return cand
        i += 1


def _pick_unique_expression_folder_key(
    character: Any, anchor_key: str, *, used_keys: set[str]
) -> str:
    base = sanitize_for_folder(f"{anchor_key}_edited", max_len=80)
    i = 0
    while True:
        cand = sanitize_for_folder(f"{base}_{i}", max_len=80)
        if cand not in used_keys and not character.expression_dir(cand).exists():
            return cand
        i += 1


def list_pose_gallery_folder_covers_split(
    char_key: str,
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """First visible/hidden image per pose folder (legacy/Qt one-tile-per-folder)."""
    vis, hid = list_pose_gallery_items_split(char_key)

    def pack(rows: list[tuple[str, str, str]]) -> list[tuple[str, str]]:
        seen: set[str] = set()
        out: list[tuple[str, str]] = []
        for _iid, fk, ap in rows:
            if fk in seen:
                continue
            seen.add(fk)
            out.append((fk, ap))
        return out

    return pack(vis), pack(hid)


def list_expression_gallery_folder_covers_split(
    char_key: str,
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    vis, hid = list_expression_gallery_items_split(char_key)

    def pack(rows: list[tuple[str, str, str]]) -> list[tuple[str, str]]:
        seen: set[str] = set()
        out: list[tuple[str, str]] = []
        for _iid, fk, ap in rows:
            if fk in seen:
                continue
            seen.add(fk)
            out.append((fk, ap))
        return out

    return pack(vis), pack(hid)


def list_pose_gallery_items_split(
    char_key: str,
) -> tuple[list[tuple[str, str, str]], list[tuple[str, str, str]]]:
    """Return (visible, hidden) lists of ``(item_id, folder_key, abs_path)``."""
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    on_disk = all_pose_flat_gallery_item_ids(char_key)
    order = _sync_pose_image_order_with_disk(char_key, st, on_disk=on_disk)
    if order != list(st.get(POSE_IMAGE_ORDER) or []):
        st[POSE_IMAGE_ORDER] = order
        write_gallery_ui_state(char_key, st)
    hidden = set(st.get(HIDDEN_POSE_IMAGES) or [])
    vis: list[tuple[str, str, str]] = []
    hid: list[tuple[str, str, str]] = []
    for iid in order:
        if iid not in on_disk:
            continue
        fk, rel = on_disk[iid]
        abs_p = str((DEFAULT_STORAGE_ROOT / rel).resolve())
        if iid in hidden:
            hid.append((iid, fk, abs_p))
        else:
            vis.append((iid, fk, abs_p))
    return vis, hid


def list_expression_gallery_items_split(
    char_key: str,
) -> tuple[list[tuple[str, str, str]], list[tuple[str, str, str]]]:
    ensure_gallery_flat_migrated(char_key)
    st = read_gallery_ui_state(char_key)
    on_disk = all_expression_flat_gallery_item_ids(char_key)
    order = _sync_expression_image_order_with_disk(char_key, st, on_disk=on_disk)
    if order != list(st.get(EXPR_IMAGE_ORDER) or []):
        st[EXPR_IMAGE_ORDER] = order
        write_gallery_ui_state(char_key, st)
    hidden = set(st.get(HIDDEN_EXPR_IMAGES) or [])
    vis: list[tuple[str, str, str]] = []
    hid: list[tuple[str, str, str]] = []
    for iid in order:
        if iid not in on_disk:
            continue
        fk, rel = on_disk[iid]
        abs_p = str((DEFAULT_STORAGE_ROOT / rel).resolve())
        if iid in hidden:
            hid.append((iid, fk, abs_p))
        else:
            vis.append((iid, fk, abs_p))
    return vis, hid


def delete_pose_folder(char_key: str, pose_key: str) -> None:
    _ = char_key
    _ = pose_key
    raise ValueError("Pose folder delete is not supported; delete individual gallery images instead.")


def delete_expression_folder(char_key: str, expr_key: str) -> None:
    _ = char_key
    _ = expr_key
    raise ValueError(
        "Expression folder delete is not supported; delete individual gallery images instead."
    )


def delete_pose_angle_images(char_key: str, pose_key: str, rel_paths: list[str]) -> int:
    """
    Delete selected images under the character pose gallery root (``poses/``).
    Returns the number of files deleted.
    """
    _ = pose_key
    character = get_character_paths(char_key)
    pose_dir = character.poses_dir.resolve()
    if not pose_dir.exists():
        return 0
    deleted = 0
    for rel in rel_paths:
        try:
            p = (DEFAULT_STORAGE_ROOT / rel).resolve()
        except Exception:
            continue
        try:
            p.relative_to(pose_dir)
        except Exception:
            continue
        if p.is_file():
            p.unlink(missing_ok=True)
            deleted += 1
    if deleted:
        ensure_gallery_flat_migrated(char_key)
        st = read_gallery_ui_state(char_key)
        on_disk = all_pose_flat_gallery_item_ids(char_key)
        st[POSE_IMAGE_ORDER] = [x for x in (st.get(POSE_IMAGE_ORDER) or []) if x in on_disk]
        st[HIDDEN_POSE_IMAGES] = [x for x in (st.get(HIDDEN_POSE_IMAGES) or []) if x in on_disk]
        write_gallery_ui_state(char_key, st)
        reassign_character_cover_if_invalid(char_key)
    return deleted


def delete_expression_angle_images(char_key: str, expr_key: str, rel_paths: list[str]) -> int:
    """
    Delete selected images under the character expression gallery root (``expressions/``).
    Returns the number of files deleted.
    """
    _ = expr_key
    character = get_character_paths(char_key)
    expr_dir = character.expressions_dir.resolve()
    if not expr_dir.exists():
        return 0
    deleted = 0
    for rel in rel_paths:
        try:
            p = (DEFAULT_STORAGE_ROOT / rel).resolve()
        except Exception:
            continue
        try:
            p.relative_to(expr_dir)
        except Exception:
            continue
        if p.is_file():
            p.unlink(missing_ok=True)
            deleted += 1
    if deleted:
        ensure_gallery_flat_migrated(char_key)
        st = read_gallery_ui_state(char_key)
        on_disk = all_expression_flat_gallery_item_ids(char_key)
        st[EXPR_IMAGE_ORDER] = [x for x in (st.get(EXPR_IMAGE_ORDER) or []) if x in on_disk]
        st[HIDDEN_EXPR_IMAGES] = [x for x in (st.get(HIDDEN_EXPR_IMAGES) or []) if x in on_disk]
        write_gallery_ui_state(char_key, st)
        reassign_character_cover_if_invalid(char_key)
    return deleted


def _rename_dir_case_safe(old: Path, new: Path) -> None:
    """Rename a directory; on Windows, case-only renames use a temp hop."""
    if not old.is_dir():
        raise ValueError("Source folder not found.")
    try:
        same_parent = old.parent.resolve() == new.parent.resolve()
    except OSError as e:
        raise ValueError(f"Cannot resolve paths: {e}") from e
    if not same_parent:
        if new.exists():
            raise ValueError(f"Target already exists: {new}")
        old.rename(new)
        return
    if old.name == new.name:
        return
    if old.name.lower() != new.name.lower():
        if new.exists():
            raise ValueError(f"Target already exists: {new}")
        old.rename(new)
        return
    tmp = old.parent / f"{old.name}.__ren_tmp_{unique_suffix()}"
    old.rename(tmp)
    tmp.rename(new)


def _fix_multi_angle_subdir_after_pose_or_expr_rename(
    folder: Path, old_key: str, new_key: str
) -> None:
    inner_old = folder / f"{old_key}_multi_angle"
    inner_new = folder / f"{new_key}_multi_angle"
    if inner_old.is_dir():
        if inner_new.exists() and inner_old.resolve() != inner_new.resolve():
            raise ValueError(
                "Cannot rename: target multi-angle folder already exists. Resolve manually."
            )
        if inner_old.resolve() != inner_new.resolve():
            inner_old.rename(inner_new)


def rename_pose_folder(char_key: str, old_key: str, new_label: str) -> str:
    _ = char_key
    _ = old_key
    _ = new_label
    raise ValueError("Pose folder rename is not supported in the flat gallery layout.")


def rename_expression_folder(char_key: str, old_key: str, new_label: str) -> str:
    _ = char_key
    _ = old_key
    _ = new_label
    raise ValueError("Expression folder rename is not supported in the flat gallery layout.")


def validate_save_character(character_name: str, base_path: str | None) -> None:
    if not character_name.strip():
        raise ValueError("Please enter a character name.")
    if not base_path:
        raise ValueError("Generate or upload a base image first.")
    if not Path(base_path).exists():
        raise ValueError("Base file does not exist.")


# --- Dataset export (LoRA training folders) ---------------------------------

DATASET_MANIFEST_NAME = "manifest.json"


def list_dataset_folder_names(char_key: str) -> list[str]:
    character = get_character_paths(char_key)
    root = character.datasets_dir
    if not root.exists():
        return []
    return sorted(
        [p.name for p in root.iterdir() if p.is_dir()],
        key=lambda s: s.lower(),
    )


def dataset_folder_path(char_key: str, dataset_name: str) -> Path:
    return get_character_paths(char_key).dataset_dir(dataset_name)


def write_dataset_folder_zip_file(char_key: str, dataset_name: str) -> tuple[str, str]:
    """Zip all files directly under the saved dataset folder (images, ``manifest.json``, etc.).

    Returns ``(absolute_path_to_temp_zip, suggested_download_filename.zip)``.
    The caller must delete the temp file after the response is sent.
    """
    raw = (dataset_name or "").strip()
    if not raw:
        raise ValueError("Dataset name is required.")
    folder = dataset_folder_path(char_key, raw)
    if not folder.is_dir():
        raise ValueError("Dataset folder not found.")
    root_name = folder.name
    entries = sorted(
        [p for p in folder.iterdir() if p.is_file()],
        key=lambda p: p.name.lower(),
    )
    if not entries:
        raise ValueError("Dataset folder is empty.")

    fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix="dataset_zip_")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fp in entries:
                zf.write(fp, arcname=f"{root_name}/{fp.name}")
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    return tmp_path, f"{root_name}.zip"


def write_gallery_images_zip_file(char_key: str, rel_paths: list[str]) -> tuple[str, str]:
    """Zip pose/expression gallery images by storage-relative paths.

    Returns ``(absolute_path_to_temp_zip, suggested_download_filename.zip)``.
    The caller must delete the temp file after the response is sent.
    """
    character = get_character_paths(char_key)
    char_root = character.character_dir.resolve()
    root_storage = DEFAULT_STORAGE_ROOT.resolve()

    seen: set[str] = set()
    entries: list[tuple[Path, str]] = []
    for raw in rel_paths or []:
        rel_norm = str(raw).strip().replace("\\", "/").lstrip("/")
        if not rel_norm or rel_norm in seen:
            continue
        seen.add(rel_norm)
        abs_p = (DEFAULT_STORAGE_ROOT / rel_norm).resolve()
        if root_storage != abs_p and root_storage not in abs_p.parents:
            raise ValueError(f"Path escapes storage root: {rel_norm}")
        if char_root != abs_p and char_root not in abs_p.parents:
            raise ValueError(f"Path is outside character folder: {rel_norm}")
        if not abs_p.is_file():
            raise ValueError(f"Image not found: {rel_norm}")
        try:
            rel_to_char = abs_p.relative_to(char_root)
        except ValueError as e:
            raise ValueError(f"Path must be under character folder: {rel_norm}") from e
        top = rel_to_char.parts[0] if rel_to_char.parts else ""
        if top not in ("poses", "expressions"):
            raise ValueError(f"Path must be under poses/ or expressions/: {rel_norm}")
        if not _is_gallery_image_file(abs_p):
            raise ValueError(f"Not a supported gallery image: {rel_norm}")
        entries.append((abs_p, rel_to_char.as_posix()))

    if not entries:
        raise ValueError("No gallery images to download.")

    fd, tmp_path = tempfile.mkstemp(suffix=".zip", prefix="gallery_zip_")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for abs_p, arcname in entries:
                zf.write(abs_p, arcname=arcname)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    safe_key = sanitize_for_folder(char_key) or "gallery"
    return tmp_path, f"{safe_key}_gallery.zip"


def delete_dataset_folder(char_key: str, dataset_name: str) -> None:
    folder = dataset_folder_path(char_key, dataset_name)
    if not folder.exists():
        raise ValueError("Dataset folder not found.")
    if not folder.is_dir():
        raise ValueError("Dataset path is not a folder.")
    shutil.rmtree(folder)


def rename_dataset_folder(
    char_key: str, old_name: str, new_label: str
) -> str:
    old_folder = dataset_folder_path(char_key, old_name)
    if not old_folder.exists() or not old_folder.is_dir():
        raise ValueError("Dataset folder not found.")

    new_key = sanitize_for_folder(new_label)
    if not new_key or new_key == "unnamed":
        raise ValueError("A dataset name is required.")
    if new_key == old_name:
        return old_name

    new_folder = dataset_folder_path(char_key, new_key)
    if new_folder.exists():
        raise ValueError(f"Target dataset already exists: {new_key!r}")

    _rename_dir_case_safe(old_folder, new_folder)
    return new_key


def duplicate_dataset_folder(char_key: str, source_name: str, new_label: str) -> str:
    """Copy ``dataset/<source_name>/`` to a new folder under ``dataset/<new_key>/``."""
    raw_src = (source_name or "").strip()
    if not raw_src:
        raise ValueError("Source dataset name is required.")
    new_key = sanitize_for_folder(new_label)
    if not new_key or new_key == "unnamed":
        raise ValueError("A dataset name is required.")
    src = dataset_folder_path(char_key, raw_src)
    if not src.is_dir():
        raise ValueError("Dataset folder not found.")
    dst = dataset_folder_path(char_key, new_key)
    if dst.exists():
        raise ValueError(f"Target dataset already exists: {new_key!r}")
    shutil.copytree(src, dst)
    return new_key


def list_dataset_image_paths(char_key: str, dataset_name: str) -> list[str]:
    folder = dataset_folder_path(char_key, dataset_name)
    if not folder.is_dir():
        return []
    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    files = [
        p
        for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in exts and p.name != DATASET_MANIFEST_NAME
    ]
    by_name = {p.name: p for p in files}

    # Prefer manifest ordering when present, append any new files.
    man_path = folder / DATASET_MANIFEST_NAME
    ordered: list[Path] = []
    if man_path.is_file():
        try:
            with open(man_path, encoding="utf-8") as f:
                data = json.load(f)
            items = list((data or {}).get("items") or [])
            for it in items:
                fn = Path(str(it.get("filename") or "")).name
                if not fn:
                    continue
                p = by_name.get(fn)
                if p is not None and p not in ordered:
                    ordered.append(p)
        except Exception:
            ordered = []

    ordered_names = {p.name for p in ordered}
    for p in sorted(files, key=lambda p: p.name.lower()):
        if p.name in ordered_names:
            continue
        ordered.append(p)
    return [str(p) for p in ordered]


def set_dataset_saved_order(char_key: str, dataset_name: str, basenames: list[str]) -> None:
    """
    Persist saved-dataset tile ordering by rewriting ``manifest.json`` item order.
    """
    folder = dataset_folder_path(char_key, dataset_name)
    if not folder.is_dir():
        raise ValueError("Dataset folder not found.")
    manifest = folder / DATASET_MANIFEST_NAME
    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    existing = sorted(
        [
            p.name
            for p in folder.iterdir()
            if p.is_file() and p.suffix.lower() in exts and p.name != DATASET_MANIFEST_NAME
        ],
        key=lambda s: s.lower(),
    )
    existing_set = set(existing)

    safe_order: list[str] = []
    seen: set[str] = set()
    for bn in basenames or []:
        fn = Path(str(bn)).name
        if not fn or fn in seen or fn not in existing_set:
            continue
        seen.add(fn)
        safe_order.append(fn)
    for fn in existing:
        if fn not in seen:
            safe_order.append(fn)

    with open(manifest, "w", encoding="utf-8") as f:
        json.dump(
            {
                "version": 1,
                "items": [{"index": i, "filename": n} for i, n in enumerate(safe_order)],
            },
            f,
            indent=2,
        )


def write_dataset_export(
    char_key: str,
    dataset_name: str,
    entries: list[dict[str, Any]],
) -> Path:
    """
    Write PNGs into ``dataset/<sanitized_name>/`` and a small manifest.

    Each entry: ``source_kind`` (``pose`` | ``expr``), ``folder_key`` (str),
    ``file_path`` (str path to copy, typically a preview temp file or source).
    """
    name = sanitize_for_folder(dataset_name)
    if not name or name == "unnamed":
        raise ValueError("Dataset name is required.")
    character = get_character_paths(char_key)
    folder = character.dataset_dir(name)
    ensure_dirs(folder)
    manifest_items: list[dict[str, Any]] = []
    for i, e in enumerate(entries):
        src = Path(str(e["file_path"]))
        if not src.is_file():
            raise ValueError(f"Missing file for export: {src}")
        kind = str(e["source_kind"])
        if kind not in ("pose", "expr"):
            raise ValueError(f"Invalid source_kind: {kind}")
        key = sanitize_for_folder(str(e["folder_key"]))
        stem = sanitize_for_folder(Path(src.name).stem, max_len=50) or f"img{i}"
        dest_name = f"{kind}__{key}_{i:04d}_{stem}.png"
        dest = folder / dest_name
        n = 0
        while dest.exists():
            n += 1
            dest_name = f"{kind}__{key}_{i:04d}_{stem}_{n}.png"
            dest = folder / dest_name
        shutil.copy2(src, dest)
        manifest_items.append(
            {
                "index": i,
                "source_kind": kind,
                "folder_key": key,
                "filename": dest_name,
            }
        )
    man_path = folder / DATASET_MANIFEST_NAME
    with open(man_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "items": manifest_items}, f, indent=2)
    return folder


def delete_dataset_image_file(char_key: str, dataset_name: str, filename: str) -> None:
    """Remove one image from a saved dataset folder (not manifest-only)."""
    folder = dataset_folder_path(char_key, dataset_name)
    safe = Path(filename).name
    if safe == DATASET_MANIFEST_NAME or not safe:
        raise ValueError("Invalid file name.")
    target = folder / safe
    if not target.is_file():
        raise ValueError("File not found.")
    target.unlink()


def rename_dataset_export_image(
    char_key: str,
    dataset_name: str,
    old_basename: str,
    new_label: str,
) -> str:
    """
    Rename one image inside ``dataset/<name>/``. Keeps the original file extension.
    Updates ``manifest.json`` item filenames when present.
    Returns the new basename.
    """
    folder = dataset_folder_path(char_key, dataset_name)
    safe_old = Path(old_basename).name
    if safe_old == DATASET_MANIFEST_NAME or not safe_old:
        raise ValueError("Invalid file name.")
    src = folder / safe_old
    if not src.is_file():
        raise ValueError("File not found.")
    stem = sanitize_for_folder(new_label)
    if not stem or stem == "unnamed":
        raise ValueError("Name is required.")
    suffix = (src.suffix or ".png").lower()
    new_base = f"{stem}{suffix}"
    if new_base == safe_old:
        return safe_old
    dest = folder / new_base
    if dest.exists():
        raise ValueError(f"A file named {new_base!r} already exists.")
    src.rename(dest)

    man_path = folder / DATASET_MANIFEST_NAME
    if man_path.is_file():
        try:
            with open(man_path, encoding="utf-8") as f:
                data = json.load(f)
            items = list(data.get("items") or [])
            changed = False
            for item in items:
                if str(item.get("filename", "")) == safe_old:
                    item["filename"] = new_base
                    changed = True
            if changed:
                data["items"] = items
                with open(man_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2)
        except Exception:
            pass

    return new_base


def save_dataset_folder_snapshot(
    char_key: str,
    dataset_name: str,
    file_updates: list[tuple[str, str]],
) -> None:
    """
    Overwrite/replace images in an existing dataset folder.

    ``file_updates`` is ``(dest_basename, src_path)`` for each file to write.
    """
    folder = dataset_folder_path(char_key, dataset_name)
    ensure_dirs(folder)
    for basename, src_path in file_updates:
        b = Path(basename).name
        if b == DATASET_MANIFEST_NAME:
            continue
        src = Path(src_path)
        if not src.is_file():
            raise ValueError(f"Missing source: {src}")
        shutil.copy2(src, folder / b)


def _extract_first_rembg_url(body: dict[str, Any]) -> str:
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    items = (body.get("variations") or {}).get("items") or []
    if not items:
        raise RuntimeError("Background removal returned no images.")
    url = (items[0].get("result") or {}).get("url")
    if not isinstance(url, str) or not url:
        raise RuntimeError("Background removal result missing url.")
    return url


def remove_background_to_temp_file(
    local_image_path: str,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run local background removal (RMBG-2.0 / Comfy + test-mode), download result to a temp ``.png``.
    Does not modify ``local_image_path``.
    """
    body = _run_service_testmode(
        "services.background_removal_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            local_image_path,
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    url = _extract_first_rembg_url(body)
    dest = Path(tempfile.gettempdir()) / f"rembg_{unique_suffix()}.png"
    download_url_to_file(url, dest)
    return str(dest)


def remove_video_background_to_temp_file(
    video_path: str,
    *,
    output_path: str | None = None,
    backbone: str = "mobilenetv3",
    device: str = "auto",
    downsample_ratio: float = 0.25,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Remove the background from a video using RobustVideoMatting (RVM).

    Uses a **persistent worker process** so the model is loaded only once
    across the entire FastAPI session.  The first call starts the worker
    (~5–15 s while weights download/load); all subsequent calls are fast.

    Returns the absolute path to the output ``.webm`` file (VP9 + alpha
    transparency, playable directly in modern browsers).

    Parameters
    ----------
    video_path : str
        Absolute path to the source video file.
    output_path : str, optional
        Destination ``.webm`` path.  If omitted a temp file is created.
    backbone : str
        ``"mobilenetv3"`` (14 MB, fast, default) or ``"resnet50"`` (~67 MB).
    device : str
        ``"auto"``, ``"cuda"``, or ``"cpu"``.
    downsample_ratio : float
        Inference resolution fraction (default 0.25).
    log_cb : callable, optional
        Receives progress log strings during inference.
    """
    from services.vid_bckgrnd_removal_ai_service.serverless import (
        remove_video_background_persistent,
    )

    src = Path(video_path)
    if not src.is_file():
        raise ValueError(f"Video not found: {src}")

    result = remove_video_background_persistent(
        src,
        output_path,
        backbone=backbone,
        device=device,
        downsample_ratio=downsample_ratio,
        log_cb=log_cb,
    )
    out = str(result.get("url") or "").strip()
    if not out or not Path(out).is_file():
        raise RuntimeError(
            f"Video background removal produced no output file (url={out!r})."
        )
    return out


def composite_image_on_gaussian_noise_to_temp(local_image_path: str) -> str:
    """
    Build RGB image: Gaussian noise plate (same size as image) with the image composited on top.
    RGBA sources use alpha; RGB sources are pasted opaque.
    Writes a temp PNG.
    """
    from PIL import Image

    from services.noise_generator_service.generate import gaussian_noise_image

    src = Path(local_image_path)
    if not src.is_file():
        raise ValueError(f"Image not found: {src}")

    fg = Image.open(src).convert("RGBA")
    w, h = fg.size
    noise_pil = gaussian_noise_image(w, h)
    bg = noise_pil.convert("RGB")
    composite = Image.new("RGBA", (w, h))
    composite.paste(bg, (0, 0))
    composite.paste(fg, (0, 0), fg)
    out_rgb = composite.convert("RGB")
    dest = Path(tempfile.gettempdir()) / f"noise_bg_{unique_suffix()}.png"
    out_rgb.save(dest, format="PNG")
    return str(dest)


def display_path_for_tile(source_path: str, preview_path: str | None) -> str:
    """Path shown on a tile: preview if set, else source."""
    if preview_path and Path(preview_path).is_file():
        return preview_path
    return source_path


# --- Pose reference / keypoint preview ----------------------------------------

POSE_REFS_DIR_NAME = ".pose_references"
POSE_REFS_MANIFEST = "refs.json"


def _pose_refs_dir(char_key: str) -> Path:
    return get_character_paths(char_key).character_dir / POSE_REFS_DIR_NAME


def _pose_refs_manifest_path(char_key: str) -> Path:
    return _pose_refs_dir(char_key) / POSE_REFS_MANIFEST


_POSE_REF_REL_PATH_KEYS = ("referenceRelPath", "keypointRelPath")


def _normalize_pose_refs_entries(
    entries: list[dict[str, Any]], transform: Callable[[str], str]
) -> int:
    """Apply ``transform`` to every pose-ref path key. Returns changed count."""
    total = 0
    for e in entries:
        if not isinstance(e, dict):
            continue
        for key in _POSE_REF_REL_PATH_KEYS:
            v = e.get(key)
            if isinstance(v, str) and v:
                nv = transform(v)
                if nv != v:
                    e[key] = nv
                    total += 1
    return total


def _read_pose_refs_manifest(char_key: str) -> list[dict[str, Any]]:
    """Load pose-reference entries; return ``referenceRelPath`` / ``keypointRelPath``
    values in storage-relative form for API compatibility.

    On-disk format is character-relative. Legacy storage-relative entries are
    migrated on first read and re-saved.
    """
    p = _pose_refs_manifest_path(char_key)
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return []
    except Exception:
        return []

    char_prefix = f"{char_key}/"

    def _strip_prefix(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(char_prefix):
            return r[len(char_prefix) :]
        return r

    stripped = _normalize_pose_refs_entries(data, _strip_prefix)
    if stripped:
        try:
            p.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _expand_prefix(rel: str) -> str:
        return _expand_rel_to_storage_rel(char_key, rel)

    _normalize_pose_refs_entries(data, _expand_prefix)
    return data


def _write_pose_refs_manifest(char_key: str, entries: list[dict[str, Any]]) -> None:
    p = _pose_refs_manifest_path(char_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    import copy

    to_persist = copy.deepcopy(entries)
    char_prefix = f"{char_key}/"

    def _strip_prefix(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(char_prefix):
            return r[len(char_prefix) :]
        return r

    _normalize_pose_refs_entries(to_persist, _strip_prefix)
    p.write_text(json.dumps(to_persist, indent=2), encoding="utf-8")


def run_pose_keypoint_for_video_frames(
    video_abs_path: str,
    log_cb: Callable[[str], None] | None = None,
) -> list[str]:
    """
    Run ``pose_keypoint_ai_service`` on a video with per-frame export.
    Returns local absolute paths of keypoint PNGs in frame order.
    """
    src = Path(video_abs_path)
    if not src.is_file():
        raise ValueError(f"Input video not found: {src}")
    body = _run_service_testmode(
        "services.pose_keypoint_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--video-url",
            video_abs_path,
            "--export-frame",
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    results = body.get("results") or []
    if not results:
        raise RuntimeError("Pose keypoint service returned no results.")
    item = results[0]
    if item.get("kind") != "frames":
        raise RuntimeError("Expected per-frame keypoint output from video.")
    urls = item.get("urls") or []
    if not urls:
        raise RuntimeError("Pose keypoint video export returned no frame urls.")
    out: list[str] = []
    for i, url in enumerate(urls):
        if not isinstance(url, str) or not url.strip():
            continue
        dest = Path(tempfile.gettempdir()) / f"kp_vid_{unique_suffix()}_{i:06d}.png"
        download_url_to_file(url.strip(), dest)
        out.append(str(dest))
    if not out:
        raise RuntimeError("Failed to download keypoint video frames.")
    return out


def run_pose_keypoint_for_image(
    image_abs_path: str,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """
    Run ``pose_keypoint_ai_service`` on a single image.
    Returns the local absolute path of the keypoint output image.
    """
    src = Path(image_abs_path)
    if not src.is_file():
        raise ValueError(f"Input image not found: {src}")
    body = _run_service_testmode(
        "services.pose_keypoint_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--image-url",
            image_abs_path,
            "--convert-local-to-url",
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    results = body.get("results") or []
    if not results:
        raise RuntimeError("Pose keypoint service returned no results.")
    url = results[0].get("url")
    local = results[0].get("local_path")
    if local and Path(local).is_file():
        return str(local)
    if not url:
        raise RuntimeError("Pose keypoint result missing url and local_path.")
    dest = Path(tempfile.gettempdir()) / f"kp_{unique_suffix()}.png"
    download_url_to_file(url, dest)
    return str(dest)


def save_pose_reference(
    char_key: str,
    source_abs: str,
    keypoint_abs: str,
) -> dict[str, Any]:
    """
    Persist a reference+keypoint pair under ``<character>/.pose_references/``.
    Returns ``{id, referenceRelPath, keypointRelPath}``.
    """
    refs_dir = _pose_refs_dir(char_key)
    refs_dir.mkdir(parents=True, exist_ok=True)
    rid = unique_suffix()
    src_ext = Path(source_abs).suffix or ".png"
    kp_ext = Path(keypoint_abs).suffix or ".png"
    ref_dest = refs_dir / f"ref_{rid}{src_ext}"
    kp_dest = refs_dir / f"kp_{rid}{kp_ext}"
    shutil.copy2(source_abs, ref_dest)
    shutil.copy2(keypoint_abs, kp_dest)
    entry = {
        "id": rid,
        "referenceRelPath": _abs_to_storage_rel(ref_dest),
        "keypointRelPath": _abs_to_storage_rel(kp_dest),
        "createdAt": time.time(),
    }
    entries = _read_pose_refs_manifest(char_key)
    entries.insert(0, entry)
    _write_pose_refs_manifest(char_key, entries)
    return entry


def list_pose_references(char_key: str) -> list[dict[str, Any]]:
    """Return saved pose references whose files still exist on disk."""
    entries = _read_pose_refs_manifest(char_key)
    root = DEFAULT_STORAGE_ROOT.resolve()
    out: list[dict[str, Any]] = []
    for e in entries:
        ref_p = root / e.get("referenceRelPath", "")
        kp_p = root / e.get("keypointRelPath", "")
        if ref_p.is_file() and kp_p.is_file():
            out.append(e)
    return out


def delete_pose_reference(char_key: str, ref_id: str) -> bool:
    """Remove a reference entry and optionally delete its files. Returns True if found."""
    entries = _read_pose_refs_manifest(char_key)
    root = DEFAULT_STORAGE_ROOT.resolve()
    remaining: list[dict[str, Any]] = []
    found = False
    for e in entries:
        if e.get("id") == ref_id:
            found = True
            for key in ("referenceRelPath", "keypointRelPath"):
                fp = root / e.get(key, "")
                if fp.is_file():
                    fp.unlink(missing_ok=True)
        else:
            remaining.append(e)
    if found:
        _write_pose_refs_manifest(char_key, remaining)
    return found


# --- Global reference library (images + shared keypoints) ---------------------


def _reference_ref_to_local(ref: str, log_cb: Callable[[str], None] | None = None) -> str:
    """Resolve a t2i result (URL or local path) to a local absolute path."""
    if ref and Path(ref).is_file():
        return str(Path(ref).resolve())
    if ref and (ref.startswith("http://") or ref.startswith("https://")):
        dest = Path(tempfile.gettempdir()) / f"ref_{unique_suffix()}.png"
        download_url_to_file(ref, dest)
        return str(dest)
    raise RuntimeError(f"Could not resolve reference image: {ref!r}")


def generate_reference_preview(
    *,
    prompt_text: str,
    width: int = 1024,
    height: int = 1024,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, str]:
    """Generate a Qwen-Image t2i image and stash it in the references ``_preview`` scratch.

    Returns ``{previewRelPath}`` (storage-relative, ``references/_preview/...``).
    """
    from services import reference_storage

    ref = run_qwen_t2i(
        prompt_text=prompt_text, width=width, height=height, log_cb=log_cb
    )
    local = _reference_ref_to_local(ref, log_cb=log_cb)
    preview_rel = reference_storage.add_preview(local)
    return {"previewRelPath": preview_rel}


def commit_reference_image(preview_rel: str) -> dict[str, Any]:
    """Promote a ``_preview`` generation into the saved Image collection."""
    from services import reference_storage

    return reference_storage.commit_preview(preview_rel)


def make_reference_keypoint_video(
    video_rel_path: str,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Run SD pose service on a video and store per-frame ref/kp pairs globally."""
    from services import reference_storage
    from services.utils import extract_video_frames_to_pngs

    rel_norm = str(video_rel_path).replace("\\", "/").lstrip("/")
    if rel_norm.lower().startswith("references/"):
        abs_path = str(reference_storage.resolve_rel(rel_norm))
    else:
        abs_path = str(resolve_storage_rel_path_to_abs(rel_norm))
    if not Path(abs_path).is_file():
        raise ValueError(f"Reference video not found: {video_rel_path}")

    ref_tmp = Path(tempfile.mkdtemp(prefix="ref_vid_frames_"))
    try:
        ref_frames = extract_video_frames_to_pngs(abs_path, str(ref_tmp))
        kp_frames = run_pose_keypoint_for_video_frames(abs_path, log_cb=log_cb)
        n = min(len(ref_frames), len(kp_frames))
        if n < 1:
            raise RuntimeError("Video keypoint extraction produced no frames.")
        if len(ref_frames) != len(kp_frames) and log_cb:
            log_cb(
                f"Note: ref frame count ({len(ref_frames)}) != kp frame count "
                f"({len(kp_frames)}); using first {n}."
            )
        return reference_storage.add_keypoint_video(
            abs_path,
            ref_frames[:n],
            kp_frames[:n],
            fps=24,
        )
    finally:
        shutil.rmtree(ref_tmp, ignore_errors=True)


def make_reference_keypoint(
    image_rel_path: str,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Run the SD pose service on a saved reference image and store the
    (original, skeleton) pair in the global keypoint collection."""
    from services import reference_storage

    rel_norm = str(image_rel_path).replace("\\", "/").lstrip("/")
    if rel_norm.lower().startswith("references/"):
        abs_path = str(reference_storage.resolve_rel(rel_norm))
    else:
        # Character-staging uploads etc. resolve under the characters root.
        abs_path = str(resolve_storage_rel_path_to_abs(rel_norm))
    if not Path(abs_path).is_file():
        raise ValueError(f"Reference image not found: {image_rel_path}")
    kp_abs = run_pose_keypoint_for_image(abs_path, log_cb=log_cb)
    return reference_storage.add_keypoint_pair(abs_path, kp_abs)


def make_reference_angle(
    image_rel_path: str,
    angle_id: int,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Generate a new camera angle from a saved reference image and store the
    result as a new reference image."""
    from services import reference_storage

    rel_norm = str(image_rel_path).replace("\\", "/").lstrip("/")
    if rel_norm.lower().startswith("references/"):
        abs_path = str(reference_storage.resolve_rel(rel_norm))
    else:
        abs_path = str(resolve_storage_rel_path_to_abs(rel_norm))
    if not Path(abs_path).is_file():
        raise ValueError(f"Reference image not found: {image_rel_path}")
    out_abs = _run_single_multi_angle_from_image(Path(abs_path), int(angle_id), log_cb=log_cb)
    return reference_storage.add_image(str(out_abs))


# --- Sequence editor (timeline) -----------------------------------------------

SEQUENCE_MANIFEST_NAME = "manifest.json"


def list_sequence_folder_names(char_key: str) -> list[str]:
    character = get_character_paths(char_key)
    root = character.sequences_dir
    if not root.exists():
        return []
    on_disk = sorted(
        [p.name for p in root.iterdir() if p.is_dir()],
        key=lambda s: s.lower(),
    )
    # Apply the persisted custom order (self-healing): saved order first, then any new folders
    # (alphabetical), dropping folders that no longer exist.
    st = read_gallery_ui_state(char_key)
    saved = [str(x) for x in (st.get(SEQUENCE_FOLDER_ORDER) or [])]
    on_disk_set = set(on_disk)
    ordered: list[str] = []
    seen: set[str] = set()
    for name in saved:
        if name in on_disk_set and name not in seen:
            ordered.append(name)
            seen.add(name)
    for name in on_disk:
        if name not in seen:
            ordered.append(name)
            seen.add(name)
    return ordered


def set_sequence_folder_order(char_key: str, names: list[str]) -> None:
    """Persist the display order of sequence folders (deduped, existing folders only)."""
    character = get_character_paths(char_key)
    root = character.sequences_dir
    on_disk = {p.name for p in root.iterdir() if p.is_dir()} if root.exists() else set()
    seen: set[str] = set()
    order: list[str] = []
    for raw in names or []:
        name = str(raw).strip()
        if name in on_disk and name not in seen:
            order.append(name)
            seen.add(name)
    st = read_gallery_ui_state(char_key)
    st[SEQUENCE_FOLDER_ORDER] = order
    write_gallery_ui_state(char_key, st)


def sequence_folder_path(char_key: str, sequence_name: str) -> Path:
    return get_character_paths(char_key).sequence_dir(sequence_name)


def delete_sequence_folder(char_key: str, sequence_name: str) -> None:
    folder = sequence_folder_path(char_key, sequence_name)
    if not folder.exists():
        raise ValueError("Sequence folder not found.")
    if not folder.is_dir():
        raise ValueError("Sequence path is not a folder.")
    shutil.rmtree(folder)


def rename_sequence_folder(char_key: str, old_name: str, new_label: str) -> str:
    old_folder = sequence_folder_path(char_key, old_name)
    if not old_folder.exists() or not old_folder.is_dir():
        raise ValueError("Sequence folder not found.")
    new_key = sanitize_for_folder(new_label)
    if not new_key or new_key == "unnamed":
        raise ValueError("A sequence name is required.")
    if new_key == old_name:
        return old_name
    new_folder = sequence_folder_path(char_key, new_key)
    if new_folder.exists():
        raise ValueError(f"Target sequence already exists: {new_key!r}")
    _rename_dir_case_safe(old_folder, new_folder)
    man_path = _sequence_manifest_path(char_key, new_key)
    if man_path.is_file():
        data = read_sequence_manifest(char_key, new_key)
        _rewrite_sequence_rel_paths_after_folder_rename(
            data, char_key, old_name, new_key
        )
        write_sequence_manifest(char_key, new_key, data)
    return new_key


def _rewrite_sequence_rel_paths_for_folder_duplicate(
    data: dict[str, Any], char_key: str, old_folder_name: str, new_folder_name: str
) -> int:
    """Rewrite every ``relPath`` in the manifest from ``sequence/<old>/`` to ``sequence/<new>/``."""
    o = (old_folder_name or "").strip()
    n = (new_folder_name or "").strip()
    if not o or not n:
        return 0
    old_prefix_rel = f"sequence/{o}/".replace("\\", "/")
    new_prefix_rel = f"sequence/{n}/".replace("\\", "/")
    ck = (char_key or "").replace("\\", "/").strip("/")
    old_prefix_storage = f"{ck}/{old_prefix_rel}" if ck else old_prefix_rel
    new_prefix_storage = f"{ck}/{new_prefix_rel}" if ck else new_prefix_rel

    def _rep(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(old_prefix_storage):
            return new_prefix_storage + r[len(old_prefix_storage) :]
        if r.startswith(old_prefix_rel):
            return new_prefix_rel + r[len(old_prefix_rel) :]
        return rel

    return _walk_sequence_manifest_rel_paths(data, _rep)


def duplicate_sequence_folder(char_key: str, source_name: str, new_label: str) -> str:
    """Copy ``sequence/<source_name>/`` to ``sequence/<new_key>/`` and fix manifest ``relPath`` values."""
    raw_src = (source_name or "").strip()
    if not raw_src:
        raise ValueError("Source sequence name is required.")
    new_key = sanitize_for_folder(new_label)
    if not new_key or new_key == "unnamed":
        raise ValueError("A sequence name is required.")
    if new_key == raw_src:
        raise ValueError("New name must differ from the source.")
    src = sequence_folder_path(char_key, raw_src)
    if not src.is_dir():
        raise ValueError("Sequence folder not found.")
    dst = sequence_folder_path(char_key, new_key)
    if dst.exists():
        raise ValueError(f"Target sequence already exists: {new_key!r}")
    shutil.copytree(src, dst)
    data = read_sequence_manifest(char_key, new_key)
    _rewrite_sequence_rel_paths_for_folder_duplicate(
        data, char_key, raw_src, new_key
    )
    write_sequence_manifest(char_key, new_key, data)
    return new_key


def _sequence_manifest_path(char_key: str, sequence_name: str) -> Path:
    return sequence_folder_path(char_key, sequence_name) / SEQUENCE_MANIFEST_NAME


def _rewrite_sequence_rel_paths_after_folder_rename(
    data: dict[str, Any],
    char_key: str,
    old_folder_name: str,
    new_folder_name: str,
) -> int:
    """Mutate manifest dict: relPath entries under sequence/<old>/ become sequence/<new>/.

    Sequences renamed before this logic shipped may still have stale relPaths; fix by editing
    manifest.json with the same prefix replace, or rename again with this code deployed.
    """
    old_prefix_rel = f"sequence/{old_folder_name}/".replace("\\", "/")
    new_prefix_rel = f"sequence/{new_folder_name}/".replace("\\", "/")
    ck = (char_key or "").replace("\\", "/").strip("/")
    old_prefix_storage = f"{ck}/{old_prefix_rel}" if ck else old_prefix_rel
    new_prefix_storage = f"{ck}/{new_prefix_rel}" if ck else new_prefix_rel

    def _rep(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(old_prefix_storage):
            return new_prefix_storage + r[len(old_prefix_storage) :]
        if r.startswith(old_prefix_rel):
            return new_prefix_rel + r[len(old_prefix_rel) :]
        return rel

    return _walk_sequence_manifest_rel_paths(data, _rep)


def repair_sequence_manifest_rel_paths(char_key: str, sequence_name: str) -> int:
    """Repair stale sequence-folder prefixes inside one manifest.

    Rewrites any ``sequence/<other>/...`` relPath to ``sequence/<sequence_name>/...``
    and validates every rewritten path still resolves under this sequence folder.
    Returns the number of rewritten relPaths.
    """
    seq = (sequence_name or "").strip()
    if not seq:
        raise ValueError("Sequence name is required.")
    data = read_sequence_manifest(char_key, seq)

    prefix_rel = "sequence/"
    target_prefix_rel = f"{prefix_rel}{seq}/".replace("\\", "/")
    ck = (char_key or "").replace("\\", "/").strip("/")
    prefix_storage = f"{ck}/sequence/" if ck else prefix_rel
    target_prefix_storage = f"{ck}/{target_prefix_rel}" if ck else target_prefix_rel

    def _repair(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(prefix_storage):
            rem = r[len(prefix_storage) :]
            if "/" not in rem:
                return rel
            folder, tail = rem.split("/", 1)
            if not folder or folder == seq:
                return rel
            return target_prefix_storage + tail
        if r.startswith(prefix_rel):
            rem = r[len(prefix_rel) :]
            if "/" not in rem:
                return rel
            folder, tail = rem.split("/", 1)
            if not folder or folder == seq:
                return rel
            return target_prefix_rel + tail
        return rel

    updated = _walk_sequence_manifest_rel_paths(data, _repair)
    if updated <= 0:
        return 0

    def _validate(rel: str) -> str:
        _ensure_rel_under_sequence_folder(char_key, seq, rel)
        return rel

    _walk_sequence_manifest_rel_paths(data, _validate)
    write_sequence_manifest(char_key, seq, data)
    return updated


def read_sequence_manifest(char_key: str, sequence_name: str) -> dict[str, Any]:
    """Load a sequence manifest and return it with storage-relative ``relPath`` values.

    Stored on disk as character-relative (no ``<char_key>/`` prefix) since the
    character folder name is the single source of truth. Legacy manifests with
    storage-relative paths are migrated on first read and re-saved.
    """
    p = _sequence_manifest_path(char_key, sequence_name)
    if not p.is_file():
        raise ValueError("Sequence manifest not found.")
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        prefix = f"{char_key}/"

        def _strip(rel: str) -> str:
            r = rel.replace("\\", "/").lstrip("/")
            if r.startswith(prefix):
                return r[len(prefix) :]
            return r

        stripped = _walk_sequence_manifest_rel_paths(data, _strip)

        manifest_aspect = data.get("previewAspect")

        def _migrate_crop(crop: dict[str, Any]) -> bool:
            return _migrate_sequence_crop_inplace(crop, manifest_aspect)

        crops_migrated = _walk_sequence_manifest_crops(data, _migrate_crop)

        if stripped or crops_migrated:
            try:
                with open(p, "w", encoding="utf-8") as wf:
                    json.dump(data, wf, indent=2)
            except OSError:
                pass

        def _expand(rel: str) -> str:
            return _expand_rel_to_storage_rel(char_key, rel)

        _walk_sequence_manifest_rel_paths(data, _expand)
    return data


def _sequence_timeline_export_fps(manifest: dict[str, Any]) -> float:
    raw = manifest.get("fps")
    try:
        fps = float(raw)
    except (TypeError, ValueError):
        return 12.0
    if not math.isfinite(fps) or fps < 1.0 or fps > 120.0:
        return 12.0
    return fps


def _sequence_timeline_span(manifest: dict[str, Any]) -> int:
    """Strip length in logical timeline columns (keep in sync with ``computeSequenceTimelineSpan`` in
    ``ui/frontend/.../sequenceGalleryUtils.ts``).
    """
    min_frames = 48
    tail_pad = 24
    max_idx = -1
    rows_raw = manifest.get("frames") or []
    for fr in rows_raw:
        if isinstance(fr, dict) and isinstance(fr.get("index"), int):
            max_idx = max(max_idx, int(fr["index"]))
    return max(min_frames, max_idx + 1 + tail_pad)


def _timeline_export_segment_counts(indices: list[int], span: int) -> list[int]:
    """Repeat counts per visible keyframe (``indices`` sorted ascending).

    Internal segments use index deltas; the final segment matches the preview wrap dwell
    from last key to first (encoded as repeats of the last image only).
    """
    n = len(indices)
    if n == 0:
        return []
    if n == 1:
        return [max(1, span - 1 - indices[0] + indices[0])]
    out: list[int] = []
    for i in range(n - 1):
        out.append(max(1, indices[i + 1] - indices[i]))
    out.append(max(1, span - 1 - indices[n - 1] + indices[0]))
    return out


def _sequence_timeline_visible_export_frames(
    char_key: str, sequence_name: str, manifest: dict[str, Any]
) -> list[tuple[int, Path, dict[str, Any] | None]]:
    """Visible timeline keyframes: ``(index, absolute_path, crop_dict_or_none)`` sorted by index."""
    rows_raw = manifest.get("frames") or []
    pairs: list[tuple[int, dict[str, Any]]] = []
    for fr in rows_raw:
        if not isinstance(fr, dict) or not isinstance(fr.get("index"), int):
            continue
        pairs.append((int(fr["index"]), fr))
    pairs.sort(key=lambda x: x[0])
    out: list[tuple[int, Path, dict[str, Any] | None]] = []
    for idx, fr in pairs:
        if fr.get("hidden") is True:
            continue
        rel = str(fr.get("relPath") or "").strip().replace("\\", "/").lstrip("/")
        if not rel:
            continue
        try:
            _ensure_rel_under_sequence_folder(char_key, sequence_name, rel)
        except ValueError as ex:
            raise ValueError(f"Timeline frame {idx}: {ex}") from ex
        pth = (DEFAULT_STORAGE_ROOT / rel).resolve()
        root = DEFAULT_STORAGE_ROOT.resolve()
        if root != pth and root not in pth.parents:
            raise ValueError(f"Timeline frame {idx}: invalid resolved path.")
        if not pth.is_file():
            raise ValueError(f"Timeline frame {idx}: missing file {rel!r}.")
        raw_crop = fr.get("crop")
        crop_dict: dict[str, Any] | None
        if isinstance(raw_crop, dict):
            crop_dict = raw_crop
        else:
            crop_dict = None
        out.append((idx, pth, crop_dict))
    return out


# Reference viewport for timeline MP4 (replaces lightbox ``0.9*vw`` × ``0.7*vh`` with fixed values).
_SEQUENCE_TIMELINE_EXPORT_MAX_W = 1920
_SEQUENCE_TIMELINE_EXPORT_MAX_H = 1080

_SEQUENCE_PREVIEW_ASPECT_RATIOS: dict[str, tuple[int, int]] = {
    "1:1": (1, 1),
    "4:3": (4, 3),
    "16:9": (16, 9),
    "9:16": (9, 16),
}


def _normalize_sequence_preview_aspect_for_export(raw: Any) -> tuple[int, int]:
    """Return ``(rw, rh)`` for ``previewAspect``; default ``16:9`` (``sequenceAspect.ts``)."""
    if isinstance(raw, str) and raw in _SEQUENCE_PREVIEW_ASPECT_RATIOS:
        return _SEQUENCE_PREVIEW_ASPECT_RATIOS[raw]
    return (16, 9)


def _fit_aspect_box(max_w: float, max_h: float, rw: float, rh: float) -> tuple[float, float]:
    """Largest axis-aligned box with aspect ``rw:rh`` that fits in ``max_w`` × ``max_h``.

    Keep in sync with ``fitAspectBox`` in ``ui/frontend/src/lib/sequenceAspect.ts``.
    """
    if max_w <= 0 or max_h <= 0 or rw <= 0 or rh <= 0:
        return (0.0, 0.0)
    r = rw / rh
    w = min(max_w, max_h * r)
    h = w / r
    if h > max_h:
        h = max_h
        w = h * r
    if w > max_w:
        w = max_w
        h = w / r
    return (w, h)


def _legacy_crop_reference_viewport(manifest_aspect: Any) -> tuple[float, float]:
    """Canonical lightbox viewport (CSS px) used to convert legacy pixel crops to fractions.

    Matches ``fitAspectBox(0.9*innerWidth, 0.7*innerHeight, ...)`` in the lightbox at the
    most common monitor size (``1920x1080``); see ``SequencePreviewLightbox.tsx``.
    Best-effort: crops authored on a different monitor will migrate approximately.
    """
    rw, rh = _normalize_sequence_preview_aspect_for_export(manifest_aspect)
    w, h = _fit_aspect_box(0.9 * 1920.0, 0.7 * 1080.0, float(rw), float(rh))
    if w <= 0 or h <= 0:
        return (1344.0, 756.0)
    return (w, h)


def _migrate_sequence_crop_inplace(crop: dict[str, Any], manifest_aspect: Any) -> bool:
    """Convert legacy pixel crop fields to fraction fields in place. Returns ``True`` if changed.

    Idempotent: a crop already in fraction form (or with neither legacy nor new fields) is
    left alone. Pixel keys ``translateX`` / ``translateY`` are removed after conversion.
    """
    has_frac_x = isinstance(crop.get("translateXFrac"), (int, float))
    has_frac_y = isinstance(crop.get("translateYFrac"), (int, float))
    has_px_x = isinstance(crop.get("translateX"), (int, float))
    has_px_y = isinstance(crop.get("translateY"), (int, float))
    if has_frac_x and has_frac_y and not has_px_x and not has_px_y:
        return False
    if not has_px_x and not has_px_y and not has_frac_x and not has_frac_y:
        return False
    ref_w, ref_h = _legacy_crop_reference_viewport(manifest_aspect)
    changed = False
    if not has_frac_x and has_px_x:
        try:
            tx = float(crop["translateX"])
            if math.isfinite(tx):
                crop["translateXFrac"] = tx / ref_w
                changed = True
        except (TypeError, ValueError):
            pass
    if not has_frac_y and has_px_y:
        try:
            ty = float(crop["translateY"])
            if math.isfinite(ty):
                crop["translateYFrac"] = ty / ref_h
                changed = True
        except (TypeError, ValueError):
            pass
    if has_px_x:
        crop.pop("translateX", None)
        changed = True
    if has_px_y:
        crop.pop("translateY", None)
        changed = True
    return changed


def _sequence_timeline_export_dimensions_even(manifest: dict[str, Any]) -> tuple[int, int]:
    """Even ``(width, height)`` for libx264 yuv420p, matching lightbox aspect inside max ref box."""
    rw, rh = _normalize_sequence_preview_aspect_for_export(manifest.get("previewAspect"))
    wf, hf = _fit_aspect_box(
        float(_SEQUENCE_TIMELINE_EXPORT_MAX_W),
        float(_SEQUENCE_TIMELINE_EXPORT_MAX_H),
        float(rw),
        float(rh),
    )
    w = int(round(wf))
    h = int(round(hf))
    w = max(2, w)
    h = max(2, h)
    if w % 2:
        w -= 1
    if h % 2:
        h -= 1
    w = max(2, w)
    h = max(2, h)
    if w < 2 or h < 2:
        return (1280, 720)
    return (w, h)


def _normalized_timeline_export_crop(crop: dict[str, Any] | None) -> tuple[float, float, float]:
    """``(translateXFrac, translateYFrac, scale)`` matching ``sequenceCrop.ts`` ``normalizeCrop``.

    Translation is a viewport-fraction (e.g. ``0.1`` = 10% of viewport width); the caller
    multiplies by the target cell ``W`` / ``H`` to get pixels.
    """
    d = crop or {}
    tx = float(d.get("translateXFrac") or 0.0)
    ty = float(d.get("translateYFrac") or 0.0)
    if not math.isfinite(tx):
        tx = 0.0
    if not math.isfinite(ty):
        ty = 0.0
    sc = float(d.get("scale") or 1.0)
    if not math.isfinite(sc) or sc < 1.0:
        sc = 1.0
    return (tx, ty, sc)


def render_sequence_timeline_cell_rgba(
    image_path: str | Path,
    crop: dict[str, Any] | None,
    cell_w: int,
    cell_h: int,
) -> Any:
    """
    Rasterize one sequence preview viewport (same stack as the lightbox / crop UI): clip to a
    ``cell_w`` × ``cell_h`` rectangle, ``object-fit: contain``, then
    ``translate(translateXFrac * cell_w, translateYFrac * cell_h) scale(scale)`` with
    origin at the viewport center. Fraction-based translation matches CSS ``translate(N%, M%)``
    in ``sequenceCrop.ts``, so the same crop renders identically in the lightbox and export.

    Returns a ``PIL.Image.Image`` in RGBA mode, size ``(cell_w, cell_h)``.
    """
    from PIL import Image

    p = Path(image_path)
    if cell_w < 2 or cell_h < 2:
        raise ValueError("cell dimensions must be at least 2.")
    tx_frac, ty_frac, sc = _normalized_timeline_export_crop(crop)
    tx = tx_frac * cell_w
    ty = ty_frac * cell_h

    im = Image.open(p)
    im = im.convert("RGBA")
    iw, ih = im.size
    if iw < 1 or ih < 1:
        raise ValueError("Source image is empty.")

    scale_contain = min(cell_w / float(iw), cell_h / float(ih))
    fw = max(1, int(round(iw * scale_contain)))
    fh = max(1, int(round(ih * scale_contain)))
    fitted = im.resize((fw, fh), Image.Resampling.LANCZOS)

    base = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
    ox = (cell_w - fw) // 2
    oy = (cell_h - fh) // 2
    base.paste(fitted, (ox, oy), fitted)

    cx = cell_w * 0.5
    cy = cell_h * 0.5
    inv_s = 1.0 / sc
    a = inv_s
    b = 0.0
    c = cx * (1.0 - inv_s) - tx / sc
    d = 0.0
    e = inv_s
    f = cy * (1.0 - inv_s) - ty / sc

    out = base.transform(
        (cell_w, cell_h),
        Image.Transform.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BILINEAR,
        fillcolor=(0, 0, 0, 0),
    )
    return out


def _flatten_rgba_for_video(im_rgba: Any, bg_rgb: tuple[int, int, int]) -> Any:
    """Composite RGBA onto opaque RGB (for yuv420p / libx264)."""
    from PIL import Image

    if im_rgba.mode != "RGBA":
        im_rgba = im_rgba.convert("RGBA")
    w, h = im_rgba.size
    bg = Image.new("RGB", (w, h), bg_rgb)
    bg.paste(im_rgba, mask=im_rgba.split()[3])
    return bg


def write_sequence_timeline_slideshow_mp4(
    char_key: str,
    sequence_name: str,
    output_path: Path | str,
) -> None:
    """
    Encodes a slideshow at ``manifest.fps`` where each logical timeline tick is ``1/fps``
    seconds. Consecutive visible keys are held for their ``index`` gap; after the last key,
    that image is held for the same duration the preview uses before wrapping to the first key.
    Skips hidden cells and cells with no ``relPath``. Each frame is rasterized like the sequence
    lightbox viewport: ``previewAspect`` + ``fitAspectBox`` (see ``sequenceAspect.ts``) inside a
    fixed ``1920×1080`` reference max, then contain-fit and manifest ``crop``; source files are
    not modified. Video is even-sized RGB (``#ffffff`` letterbox for transparent areas).
    """
    manifest = read_sequence_manifest(char_key, sequence_name)
    fps = _sequence_timeline_export_fps(manifest)
    export_frames = _sequence_timeline_visible_export_frames(char_key, sequence_name, manifest)
    if not export_frames:
        raise ValueError(
            "No timeline images to export (add frames with images or unhide cells)."
        )

    import av
    import numpy as np

    span = _sequence_timeline_span(manifest)
    indices = [fe[0] for fe in export_frames]
    segment_counts = _timeline_export_segment_counts(indices, span)

    w, h = _sequence_timeline_export_dimensions_even(manifest)
    # Opaque letterbox for transparent pixels (H.264 yuv420p has no alpha).
    export_bg = (255, 255, 255)

    def load_rgb_array(path: Path, crop: dict[str, Any] | None) -> Any:
        rgba = render_sequence_timeline_cell_rgba(path, crop, w, h)
        rgb = _flatten_rgba_for_video(rgba, export_bg)
        return np.asarray(rgb, dtype=np.uint8)

    rate = max(1, min(120, int(round(fps))))
    out_p = Path(output_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)

    try:
        with av.open(str(out_p), mode="w") as container:
            stream = container.add_stream("libx264", rate=rate)
            stream.width = w
            stream.height = h
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "23", "preset": "veryfast"}

            for (_idx, path, crop), count in zip(export_frames, segment_counts, strict=True):
                arr = load_rgb_array(path, crop)
                for _ in range(count):
                    frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                    frame = frame.reformat(format="yuv420p")
                    for packet in stream.encode(frame):
                        if packet is not None:
                            container.mux(packet)
            for packet in stream.encode(None):
                if packet is not None:
                    container.mux(packet)
    except Exception as ex:
        if out_p.is_file():
            out_p.unlink(missing_ok=True)
        raise RuntimeError(f"Timeline MP4 export failed: {ex}") from ex


def _frame_sequence_strip_slot_visible_for_export(slot: dict[str, Any]) -> bool:
    """Strip image cell shown in set export (not empty, not strip-hidden)."""
    if str(slot.get("kind") or "") != "image":
        return False
    if slot.get("hidden") is True:
        return False
    rel = str(slot.get("relPath") or "").strip().replace("\\", "/").lstrip("/")
    return bool(rel)


def write_gallery_frame_sequence_set_mp4(
    char_key: str,
    sequence_name: str,
    gallery_item_id: str,
    output_path: Path | str,
) -> None:
    """
    Linear MP4 for one gallery item's ``frameSequence.strip`` at 24 fps.

    Walks the strip in order. ``empty`` slots each emit one output frame (hold: repeat the
    last visible image, or white before any visible). A **hidden image** (``kind: image`` and
    ``hidden: true``) emits no output frame (same idea as skipped hidden timeline cells).
    Visible image slots update the current display then emit.
    """
    manifest = read_sequence_manifest(char_key, sequence_name)
    gallery = manifest.get("gallery") or []
    if not isinstance(gallery, list):
        raise ValueError("Invalid manifest: gallery must be a list.")
    gid = str(gallery_item_id or "").strip()
    if not gid:
        raise ValueError("gallery_item_id is required.")
    item: dict[str, Any] | None = None
    for g in gallery:
        if isinstance(g, dict) and str(g.get("id") or "").strip() == gid:
            item = g
            break
    if item is None:
        raise ValueError(f"No gallery item with id {gid!r}.")
    fs = item.get("frameSequence")
    if not isinstance(fs, dict):
        raise ValueError("Gallery item has no frameSequence.")
    strip_raw = fs.get("strip")
    if not isinstance(strip_raw, list) or len(strip_raw) == 0:
        raise ValueError("frameSequence.strip is missing or empty.")
    strip: list[dict[str, Any]] = [s for s in strip_raw if isinstance(s, dict)]

    import av
    import numpy as np
    from PIL import Image

    w, h = _sequence_timeline_export_dimensions_even(manifest)
    export_bg = (255, 255, 255)
    rate = 24

    def load_rgb_array(path: Path, crop: dict[str, Any] | None) -> Any:
        rgba = render_sequence_timeline_cell_rgba(path, crop, w, h)
        rgb = _flatten_rgba_for_video(rgba, export_bg)
        return np.asarray(rgb, dtype=np.uint8)

    def blank_rgb_array() -> Any:
        return np.asarray(Image.new("RGB", (w, h), export_bg), dtype=np.uint8)

    current_path: Path | None = None
    current_crop: dict[str, Any] | None = None

    out_p = Path(output_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    L = len(strip)
    frames_written = 0

    try:
        with av.open(str(out_p), mode="w") as container:
            stream = container.add_stream("libx264", rate=rate)
            stream.width = w
            stream.height = h
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "23", "preset": "veryfast"}

            for k in range(L):
                slot = strip[k]
                if str(slot.get("kind") or "") == "image" and slot.get("hidden") is True:
                    continue
                if _frame_sequence_strip_slot_visible_for_export(slot):
                    rel = str(slot.get("relPath") or "").strip().replace("\\", "/").lstrip("/")
                    _ensure_rel_under_sequence_folder(char_key, sequence_name, rel)
                    pth = (DEFAULT_STORAGE_ROOT / rel).resolve()
                    root = DEFAULT_STORAGE_ROOT.resolve()
                    if root != pth and root not in pth.parents:
                        raise ValueError(f"Strip slot {k}: invalid resolved path.")
                    if not pth.is_file():
                        raise ValueError(f"Strip slot {k}: missing file {rel!r}.")
                    raw_crop = slot.get("crop")
                    crop_dict: dict[str, Any] | None
                    if isinstance(raw_crop, dict):
                        crop_dict = raw_crop
                    else:
                        crop_dict = None
                    current_path = pth
                    current_crop = crop_dict

                if current_path is not None:
                    arr = load_rgb_array(current_path, current_crop)
                else:
                    arr = blank_rgb_array()

                frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                frame = frame.reformat(format="yuv420p")
                for packet in stream.encode(frame):
                    if packet is not None:
                        container.mux(packet)
                frames_written += 1
            for packet in stream.encode(None):
                if packet is not None:
                    container.mux(packet)
        if frames_written == 0:
            if out_p.is_file():
                out_p.unlink(missing_ok=True)
            raise ValueError(
                "No frames to export: frameSequence.strip is only hidden images, "
                "or has no non-hidden slots that emit a frame."
            )
    except ValueError:
        if out_p.is_file():
            out_p.unlink(missing_ok=True)
        raise
    except Exception as ex:
        if out_p.is_file():
            out_p.unlink(missing_ok=True)
        raise RuntimeError(f"Frame sequence set MP4 export failed: {ex}") from ex


def probe_video_meta(path: Path | str) -> dict[str, Any]:
    """Return ``{durationSec, width, height}`` for an mp4/video via PyAV.

    Duration falls back to (nb_frames / rate) when the container reports none.
    """
    import av

    p = Path(path)
    duration_sec = 0.0
    width = 0
    height = 0
    with av.open(str(p)) as container:
        vs = next((s for s in container.streams if s.type == "video"), None)
        if vs is not None:
            if vs.width:
                width = int(vs.width)
            if vs.height:
                height = int(vs.height)
            if container.duration:
                duration_sec = float(container.duration) / float(av.time_base)
            elif vs.duration is not None and vs.time_base is not None:
                duration_sec = float(vs.duration) * float(vs.time_base)
            elif vs.frames and vs.average_rate:
                duration_sec = float(vs.frames) / float(vs.average_rate)
    return {
        "durationSec": round(duration_sec, 4),
        "width": width,
        "height": height,
    }


def materialize_sequence_to_timeline_clip(
    char_key: str,
    sequence_name: str,
    gallery_item_id: str | None,
    dest_dir: Path | str,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Render a character sequence (or one gallery video item) to a persistent
    ``.mp4`` inside ``dest_dir`` and return ``{absPath, durationSec, width, height}``.

    Reuses the existing PyAV exporters: a specific ``gallery_item_id`` renders that
    item's ``frameSequence`` strip; otherwise the whole timeline slideshow is used.
    """
    import uuid

    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    out_path = dest / f"clip_{uuid.uuid4().hex}.mp4"

    gid = (gallery_item_id or "").strip()
    if log_cb:
        log_cb(
            f"Rendering {'gallery item' if gid else 'sequence timeline'} "
            f"{sequence_name!r} to mp4…"
        )
    if gid:
        write_gallery_frame_sequence_set_mp4(char_key, sequence_name, gid, out_path)
    else:
        write_sequence_timeline_slideshow_mp4(char_key, sequence_name, out_path)

    if not out_path.is_file():
        raise RuntimeError("Sequence materialization produced no file.")
    meta = probe_video_meta(out_path)
    if log_cb:
        log_cb(
            f"Rendered {out_path.name} "
            f"({meta['width']}x{meta['height']}, {meta['durationSec']}s)."
        )
    return {"absPath": str(out_path), **meta}


def import_image_to_timeline_clip(
    source_abs_path: Path | str,
    dest_dir: Path | str,
) -> dict[str, Any]:
    """Copy an image (location/shot/etc.) into ``dest_dir`` and return
    ``{absPath, width, height}``."""
    import shutil
    import uuid

    from PIL import Image

    src = Path(source_abs_path)
    if not src.is_file():
        raise ValueError(f"Image not found: {source_abs_path}")
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower() or ".png"
    out_path = dest / f"clip_{uuid.uuid4().hex}{ext}"
    shutil.copy2(src, out_path)

    width = 0
    height = 0
    try:
        with Image.open(out_path) as im:
            width, height = int(im.width), int(im.height)
    except Exception:
        pass
    return {"absPath": str(out_path), "width": width, "height": height}


def _ensure_rel_under_sequence_folder(
    char_key: str, sequence_name: str, rel_path: str
) -> None:
    """Validate that ``rel_path`` (storage-relative or character-relative) resolves
    to a file/dir under the sequence's folder for ``(char_key, sequence_name)``.
    """
    folder = sequence_folder_path(char_key, sequence_name).resolve()
    rel_norm = rel_path.replace("\\", "/").lstrip("/")
    char_prefix = f"{char_key}/"
    if rel_norm.startswith(char_prefix):
        target = (DEFAULT_STORAGE_ROOT / rel_norm).resolve()
        root = DEFAULT_STORAGE_ROOT.resolve()
        if root != target and root not in target.parents:
            raise ValueError("Invalid path")
    else:
        try:
            target = resolve_char_rel_path_to_abs(char_key, rel_norm)
        except ValueError as ex:
            raise ValueError("Invalid path") from ex
    if folder != target and folder not in target.parents:
        raise ValueError("Path escapes sequence folder")


def _validate_sequence_crop(crop: Any) -> None:
    if crop is None:
        return
    if not isinstance(crop, dict):
        raise ValueError("Invalid sequence crop: expected object")
    for key in ("translateXFrac", "translateYFrac", "scale"):
        if key not in crop:
            continue
        v = crop[key]
        if not isinstance(v, (int, float)):
            raise ValueError(f"Invalid sequence crop: {key} must be a number")
        if not math.isfinite(float(v)):
            raise ValueError(f"Invalid sequence crop: {key} must be finite")
    if "scale" in crop and crop["scale"] is not None:
        if float(crop["scale"]) < 1:
            raise ValueError("Invalid sequence crop: scale must be >= 1")


def _validate_frame_sequence_object(
    char_key: str, sequence_name: str, fs: Any, *, label: str
) -> None:
    if fs is None:
        return
    if not isinstance(fs, dict):
        raise ValueError(f"{label}: frameSequence must be an object")
    sgid = fs.get("sequenceGroupId")
    if sgid is not None and not isinstance(sgid, str):
        raise ValueError(f"{label}: sequenceGroupId must be a string")

    strip = fs.get("strip")
    if strip is not None:
        if not isinstance(strip, list):
            raise ValueError(f"{label}: strip must be an array")
        for i, slot in enumerate(strip):
            if not isinstance(slot, dict):
                raise ValueError(f"{label}: strip[{i}] must be an object")
            kind = slot.get("kind")
            if kind not in ("image", "empty"):
                raise ValueError(f"{label}: strip[{i}].kind must be 'image' or 'empty'")
            hid = slot.get("hidden")
            if hid is not None and not isinstance(hid, bool):
                raise ValueError(f"{label}: strip[{i}].hidden must be a boolean")
            rel = str(slot.get("relPath") or "").replace("\\", "/").lstrip("/")
            if kind == "image":
                if not rel:
                    raise ValueError(f"{label}: strip[{i}] image requires relPath")
                _ensure_rel_under_sequence_folder(char_key, sequence_name, rel)
                pth = (DEFAULT_STORAGE_ROOT / rel.replace("\\", "/")).resolve()
                if not pth.is_file():
                    raise ValueError(f"{label}: missing file {rel}")
            elif rel:
                raise ValueError(f"{label}: strip[{i}] empty slot must not have relPath")
            if "crop" in slot:
                _validate_sequence_crop(slot.get("crop"))

    hidden = fs.get("hidden")
    if hidden is not None:
        if not isinstance(hidden, list):
            raise ValueError(f"{label}: hidden must be an array")
        for j, h in enumerate(hidden):
            if not isinstance(h, dict):
                raise ValueError(f"{label}: hidden[{j}] must be an object")
            rel = str(h.get("relPath") or "").replace("\\", "/").lstrip("/")
            if not rel:
                raise ValueError(f"{label}: hidden[{j}] requires relPath")
            _ensure_rel_under_sequence_folder(char_key, sequence_name, rel)
            hp = (DEFAULT_STORAGE_ROOT / rel.replace("\\", "/")).resolve()
            if not hp.is_file():
                raise ValueError(f"{label}: missing hidden file {rel}")
            ai = h.get("afterIndex")
            if not isinstance(ai, int):
                raise ValueError(f"{label}: hidden[{j}].afterIndex must be an integer")
            if "crop" in h:
                _validate_sequence_crop(h.get("crop"))


def write_sequence_manifest(char_key: str, sequence_name: str, data: dict[str, Any]) -> None:
    folder = sequence_folder_path(char_key, sequence_name)
    if not folder.is_dir():
        raise ValueError("Sequence folder not found.")
    ver = data.get("version")
    if ver != 1:
        raise ValueError("Unsupported sequence manifest version")
    if "previewAspect" in data and data["previewAspect"] is not None:
        pa = data["previewAspect"]
        if pa not in ("1:1", "4:3", "16:9", "9:16"):
            raise ValueError("Invalid sequence previewAspect")
    for gi, item in enumerate(data.get("gallery") or []):
        if not isinstance(item, dict):
            continue
        rel = str(item.get("relPath") or "").replace("\\", "/")
        if rel:
            _ensure_rel_under_sequence_folder(char_key, sequence_name, rel)
        if "crop" in item:
            _validate_sequence_crop(item.get("crop"))
        if "frameSequence" in item:
            _validate_frame_sequence_object(
                char_key,
                sequence_name,
                item.get("frameSequence"),
                label=f"gallery[{gi}]",
            )
    for fi, fr in enumerate(data.get("frames") or []):
        if not isinstance(fr, dict):
            continue
        rel = str(fr.get("relPath") or "").replace("\\", "/")
        if rel:
            _ensure_rel_under_sequence_folder(char_key, sequence_name, rel)
        if "crop" in fr:
            _validate_sequence_crop(fr.get("crop"))
        if "sequenceGroupId" in fr:
            sg = fr.get("sequenceGroupId")
            if sg is not None and not isinstance(sg, str):
                raise ValueError(f"frames[{fi}].sequenceGroupId must be a string")
    man = folder / SEQUENCE_MANIFEST_NAME
    to_persist = _sequence_manifest_normalized_for_disk(char_key, data)
    with open(man, "w", encoding="utf-8") as f:
        json.dump(to_persist, f, indent=2)


def _sequence_manifest_normalized_for_disk(
    char_key: str, data: dict[str, Any]
) -> dict[str, Any]:
    """Return a deep copy of ``data`` with every ``relPath`` stripped of the
    ``<char_key>/`` prefix so the on-disk representation is character-relative.
    """
    import copy

    out = copy.deepcopy(data)
    prefix = f"{char_key}/"

    def _strip(rel: str) -> str:
        r = rel.replace("\\", "/").lstrip("/")
        if r.startswith(prefix):
            return r[len(prefix) :]
        return r

    _walk_sequence_manifest_rel_paths(out, _strip)
    return out


def _validate_flf_timeline_selection(
    manifest: dict[str, Any], start_index: int, end_index: int
) -> None:
    if start_index >= end_index:
        raise ValueError("startIndex must be less than endIndex")
    rows = [
        f
        for f in (manifest.get("frames") or [])
        if isinstance(f, dict) and isinstance(f.get("index"), int)
    ]
    by_idx: dict[int, dict[str, Any]] = {}
    for f in rows:
        by_idx[int(f["index"])] = f
    a = by_idx.get(start_index)
    b = by_idx.get(end_index)
    if not a or not str(a.get("relPath") or "").strip():
        raise ValueError("Start frame must have an image.")
    if not b or not str(b.get("relPath") or "").strip():
        raise ValueError("End frame must have an image.")
    for k in range(start_index + 1, end_index):
        if k in by_idx:
            raise ValueError(
                "Timeline cells strictly between start and end must be empty (no keyframe row)."
            )


def generate_flf_sequence(
    char_key: str,
    sequence_name: str,
    *,
    start_index: int,
    end_index: int,
    length: int = 33,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Run FLF2V with individual PNG frames; save under sequence gallery and return
    a gallery item dict with ``frameSequence`` for the UI manifest.
    """
    manifest = read_sequence_manifest(char_key, sequence_name)
    _validate_flf_timeline_selection(manifest, start_index, end_index)
    rows = [
        f
        for f in (manifest.get("frames") or [])
        if isinstance(f, dict) and isinstance(f.get("index"), int)
    ]
    by_idx = {int(f["index"]): f for f in rows}
    rel_a = str(by_idx[start_index].get("relPath") or "").replace("\\", "/").lstrip("/")
    rel_b = str(by_idx[end_index].get("relPath") or "").replace("\\", "/").lstrip("/")
    root = DEFAULT_STORAGE_ROOT.resolve()
    path_a = (root / rel_a).resolve()
    path_b = (root / rel_b).resolve()
    if not path_a.is_file() or not path_b.is_file():
        raise ValueError("Source timeline images not found on disk.")

    if log_cb:
        log_cb(
            f"FLF inputs: start={start_index} end={end_index} length={int(length)} "
            f"path_a={path_a} path_b={path_b}"
        )

    frame_urls = _run_flf_service(path_a, path_b, int(length), log_cb=log_cb)

    return gallery_item_from_frame_urls(
        char_key=char_key,
        sequence_name=sequence_name,
        frame_urls=frame_urls,
        gallery_subdir_prefix="flf",
        error_tag="FLF",
    )


def _validate_i2v_timeline_single_frame(
    manifest: dict[str, Any], frame_index: int
) -> None:
    rows = [
        f
        for f in (manifest.get("frames") or [])
        if isinstance(f, dict) and isinstance(f.get("index"), int)
    ]
    by_idx: dict[int, dict[str, Any]] = {}
    for f in rows:
        by_idx[int(f["index"])] = f
    row = by_idx.get(int(frame_index))
    if not row or not str(row.get("relPath") or "").strip():
        raise ValueError(f"Timeline frame {frame_index} must have an image.")
    rel = str(row.get("relPath") or "").replace("\\", "/").lstrip("/")
    root = DEFAULT_STORAGE_ROOT.resolve()
    path = (root / rel).resolve()
    if not path.is_file():
        raise ValueError("Source timeline image not found on disk.")


def generate_i2v_sequence(
    char_key: str,
    sequence_name: str,
    *,
    frame_index: int,
    length: int = 129,
    width: int | None = None,
    height: int | None = None,
    positive_prompt: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Run img2video (Hunyuan 1.5 I2V) with per-frame PNG output; save under sequence
    gallery and return a gallery item dict with ``frameSequence`` for the UI manifest.
    """
    manifest = read_sequence_manifest(char_key, sequence_name)
    _validate_i2v_timeline_single_frame(manifest, frame_index)
    rows = [
        f
        for f in (manifest.get("frames") or [])
        if isinstance(f, dict) and isinstance(f.get("index"), int)
    ]
    by_idx = {int(f["index"]): f for f in rows}
    rel = str(by_idx[int(frame_index)].get("relPath") or "").replace("\\", "/").lstrip(
        "/"
    )
    root = DEFAULT_STORAGE_ROOT.resolve()
    path_img = (root / rel).resolve()
    if not path_img.is_file():
        raise ValueError("Source timeline image not found on disk.")

    text = (positive_prompt or "").strip()
    if not text:
        raise ValueError("positivePrompt is required for I2V generation.")

    prompt_snip = text.replace("\n", " ").replace("\r", "")
    if len(prompt_snip) > 120:
        prompt_snip = prompt_snip[:117] + "..."

    if log_cb:
        log_cb(
            f"I2V inputs: frame_index={int(frame_index)} length={int(length)} "
            f"path={path_img} prompt_snippet={prompt_snip!r}"
        )

    urls_out = _run_i2v_service(
        path_img, text, int(length), width, height, log_cb=log_cb
    )

    return gallery_item_from_frame_urls(
        char_key=char_key,
        sequence_name=sequence_name,
        frame_urls=urls_out,
        gallery_subdir_prefix="i2v",
        error_tag="I2V",
    )


# ---------------------------------------------------------------------------
# Shared FLF / I2V service cores (reused by sequence + timeline callers)
# ---------------------------------------------------------------------------


def _run_flf_service(
    path_a: Path,
    path_b: Path,
    length: int,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> list[str]:
    """Invoke flf2video with two endpoint image paths; return ordered frame URLs."""
    body = _run_service_testmode(
        "services.flf2video_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--individual-frames",
            "--image-url",
            json.dumps([str(path_a), str(path_b)]),
            "--frames",
            "1,2",
            "--length",
            str(int(length)),
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    results = body.get("results") or []
    if not results:
        raise RuntimeError("FLF returned no results.")
    pair0 = results[0] if isinstance(results[0], dict) else {}
    frame_urls = pair0.get("frame_urls")
    if not isinstance(frame_urls, list) or not frame_urls:
        raise RuntimeError(
            "FLF did not return frame_urls (is the service running with --individual-frames?)."
        )
    return [str(u).strip() for u in frame_urls if isinstance(u, str) and str(u).strip()]


def _run_i2v_service(
    path_img: Path,
    prompt_text: str,
    length: int,
    width: int | None,
    height: int | None,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> list[str]:
    """Invoke img2video with one image + prompt; return ordered frame URLs."""
    argv: list[str] = [
        "--test-mode",
        "--enable-default",
        "--default-port",
        str(COMFY_PORT),
        "--individual-frames",
        "--image-url",
        str(path_img),
        "--length",
        str(max(1, int(length))),
        "--positive-prompt",
        prompt_text,
    ]
    if width is not None:
        argv.extend(["--width", str(int(width))])
    if height is not None:
        argv.extend(["--height", str(int(height))])

    body = _run_service_testmode(
        "services.img2video_ai_service.serverless",
        argv,
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    results = body.get("results") or []
    if not results:
        raise RuntimeError("I2V returned no results.")
    r0 = results[0] if isinstance(results[0], dict) else {}
    frame_urls = r0.get("frame_urls")
    if not isinstance(frame_urls, list) or not frame_urls:
        raise RuntimeError(
            "I2V did not return frame_urls (is the service running with --individual-frames?)."
        )
    return [str(u).strip() for u in frame_urls if isinstance(u, str) and str(u).strip()]


def _download_frame_urls_to_dir(frame_urls: list[str], out_dir: Path) -> list[Path]:
    """Download ordered frame URLs to ``out_dir`` as ``frame_000001.png`` etc."""
    from services.character_storage import download_url_to_file

    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for i, url in enumerate(frame_urls):
        u = str(url or "").strip()
        if not u:
            continue
        dest = out_dir / f"frame_{i + 1:06d}.png"
        download_url_to_file(u, dest)
        paths.append(dest)
    if not paths:
        raise RuntimeError("No frames were downloaded.")
    return paths


def encode_frames_to_mp4(
    frame_paths: list[Path], out_path: Path | str, fps: int = 24
) -> None:
    """Encode an ordered list of image frames into an H.264 mp4 (PyAV)."""
    import av
    import numpy as np
    from PIL import Image

    if not frame_paths:
        raise ValueError("No frames to encode.")
    out_p = Path(out_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)

    # Even dimensions (yuv420p requirement) from the first frame.
    with Image.open(frame_paths[0]) as im0:
        w, h = im0.size
    w = max(2, w - (w % 2))
    h = max(2, h - (h % 2))
    rate = max(1, min(120, int(round(fps))))

    try:
        with av.open(str(out_p), mode="w") as container:
            stream = container.add_stream("libx264", rate=rate)
            stream.width = w
            stream.height = h
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "20", "preset": "veryfast"}
            for fp in frame_paths:
                with Image.open(fp) as im:
                    rgb = im.convert("RGB").resize((w, h))
                    arr = np.asarray(rgb, dtype=np.uint8)
                frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                frame = frame.reformat(format="yuv420p")
                for packet in stream.encode(frame):
                    if packet is not None:
                        container.mux(packet)
            for packet in stream.encode(None):
                if packet is not None:
                    container.mux(packet)
    except Exception as ex:
        if out_p.is_file():
            out_p.unlink(missing_ok=True)
        raise RuntimeError(f"Frame mp4 encode failed: {ex}") from ex


def _frames_to_timeline_clip(
    frame_urls: list[str], dest_dir: Path | str, *, fps: int = 24
) -> dict[str, Any]:
    """Download generated frame URLs → encode mp4 in ``dest_dir`` → probe meta."""
    import tempfile
    import uuid

    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="tl_frames_"))
    try:
        frames = _download_frame_urls_to_dir(frame_urls, tmp)
        out_path = dest / f"clip_{uuid.uuid4().hex}.mp4"
        encode_frames_to_mp4(frames, out_path, fps=fps)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    meta = probe_video_meta(out_path)
    return {"absPath": str(out_path), **meta}


def generate_flf_to_timeline_clip(
    image_a_abs_path: str,
    image_b_abs_path: str,
    dest_dir: Path | str,
    *,
    length: int = 33,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """FLF between two image files → mp4 clip in ``dest_dir``; returns clip meta."""
    pa = Path(image_a_abs_path)
    pb = Path(image_b_abs_path)
    if not pa.is_file() or not pb.is_file():
        raise ValueError("FLF source images not found on disk.")
    if log_cb:
        log_cb(f"FLF: {pa.name} → {pb.name} (length={int(length)})")
    frame_urls = _run_flf_service(pa, pb, int(length), log_cb=log_cb)
    return _frames_to_timeline_clip(frame_urls, dest_dir)


def generate_i2v_to_timeline_clip(
    image_abs_path: str,
    prompt: str,
    dest_dir: Path | str,
    *,
    length: int = 129,
    width: int | None = None,
    height: int | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """I2V from one image + prompt → mp4 clip in ``dest_dir``; returns clip meta."""
    p = Path(image_abs_path)
    if not p.is_file():
        raise ValueError("I2V source image not found on disk.")
    text = (prompt or "").strip()
    if not text:
        raise ValueError("A prompt is required for I2V generation.")
    if log_cb:
        log_cb(f"I2V: {p.name} (length={int(length)})")
    frame_urls = _run_i2v_service(p, text, int(length), width, height, log_cb=log_cb)
    return _frames_to_timeline_clip(frame_urls, dest_dir)


def ai_edit_to_timeline_clip(
    source_image_abs_path: str,
    prompt: str,
    dest_dir: Path | str,
    *,
    mask_png_base64: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """AI-edit a single image (optional mask) → new image in ``dest_dir``."""
    import uuid

    from PIL import Image

    src = Path(source_image_abs_path)
    if not src.is_file():
        raise ValueError("AI-edit source image not found on disk.")
    text = (prompt or "").strip()
    if not text:
        raise ValueError("A prompt is required for AI editing.")

    mask_abs: str | None = None
    if mask_png_base64:
        mask_abs = decode_mask_png_to_temp_file(mask_png_base64)

    temp_out = ai_edit_image_inline_to_temp_file(
        input_image_abs_path=str(src),
        prompt_text=text,
        mask_abs_path=mask_abs,
        log_cb=log_cb,
    )

    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    ext = Path(temp_out).suffix.lower() or ".png"
    out_path = dest / f"clip_{uuid.uuid4().hex}{ext}"
    shutil.copy2(temp_out, out_path)

    width = 0
    height = 0
    try:
        with Image.open(out_path) as im:
            width, height = int(im.width), int(im.height)
    except Exception:
        pass
    return {"absPath": str(out_path), "width": width, "height": height}


def _validate_sam3_segment_input(
    positive: list[dict[str, Any]], text_prompt: str | None
) -> str:
    text = (text_prompt or "").strip()
    if not positive and not text:
        raise ValueError("Provide at least one positive point or a text prompt.")
    return text


def _sam3_coords_json(positive: list[dict[str, Any]], negative: list[dict[str, Any]]) -> tuple[str, str]:
    pos_out: list[dict[str, int]] = []
    for pt in positive or []:
        if not isinstance(pt, dict):
            continue
        try:
            pos_out.append({"x": int(pt["x"]), "y": int(pt["y"])})
        except (KeyError, TypeError, ValueError):
            continue
    neg_out: list[dict[str, int]] = []
    for pt in negative or []:
        if not isinstance(pt, dict):
            continue
        try:
            neg_out.append({"x": int(pt["x"]), "y": int(pt["y"])})
        except (KeyError, TypeError, ValueError):
            continue
    return json.dumps(pos_out), json.dumps(neg_out)


def _run_sam3_segment_service(
    *,
    job: str,
    image_abs_path: str | None = None,
    video_abs_path: str | None = None,
    positive_coords: list[dict[str, Any]],
    negative_coords: list[dict[str, Any]] | None = None,
    text_prompt: str | None = None,
    ref_frame_index: int = 0,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    text = _validate_sam3_segment_input(positive_coords or [], text_prompt)
    pos_json, neg_json = _sam3_coords_json(positive_coords or [], negative_coords or [])
    args = [
        "--test-mode",
        "--enable-default",
        "--default-port",
        str(COMFY_PORT),
        "--job",
        job,
        "--positive-coords",
        pos_json,
        "--negative-coords",
        neg_json,
        "--ref-frame-index",
        str(max(0, int(ref_frame_index))),
        "--convert-local-to-url",
    ]
    if text:
        args.extend(["--text-prompt", text])
    if job == "video_masks":
        if not video_abs_path:
            raise ValueError("video_abs_path is required for video_masks.")
        args.extend(["--video-url", video_abs_path])
    else:
        if not image_abs_path:
            raise ValueError("image_abs_path is required.")
        args.extend(["--image-url", image_abs_path])
    body = _run_service_testmode(
        "services.sam3_segment_ai_service.serverless",
        args,
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))
    result = body.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("SAM3 segment returned no result.")
    return result


def _download_sam3_output_urls(result: dict[str, Any], dest_dir: Path) -> list[str]:
    urls = result.get("urls")
    if not isinstance(urls, list) or not urls:
        url = result.get("url")
        if isinstance(url, str) and url.strip():
            urls = [url.strip()]
        else:
            raise RuntimeError("SAM3 segment result missing url(s).")
    dest_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for i, url in enumerate(urls):
        if not isinstance(url, str) or not url.strip():
            continue
        ext = infer_ext_from_url(url) or ".png"
        dest = dest_dir / f"sam3_{unique_suffix(8)}_{i:05d}{ext}"
        download_url_to_file(url.strip(), dest)
        paths.append(str(dest))
    if not paths:
        raise RuntimeError("SAM3 segment produced no downloadable outputs.")
    return paths


def mask_to_rgba_cutout(*, image_abs_path: str, mask_abs_path: str) -> str:
    """Apply grayscale mask (white=keep) as alpha; write temp RGBA PNG."""
    from PIL import Image

    base = Image.open(image_abs_path).convert("RGBA")
    mask = Image.open(mask_abs_path).convert("L").resize(base.size)
    base.putalpha(mask)
    dest = Path(tempfile.gettempdir()) / f"sam3_rgba_{unique_suffix()}.png"
    base.save(dest, format="PNG")
    return str(dest)


def probe_video_fps_and_frame_count(video_path: str | Path) -> tuple[float, int]:
    import av

    p = Path(video_path)
    with av.open(str(p)) as container:
        stream = container.streams.video[0]
        fps = float(stream.average_rate or stream.base_rate or 24)
        total = int(stream.frames or 0)
        if total <= 0 and stream.duration and stream.time_base:
            dur_sec = float(stream.duration * stream.time_base)
            total = max(0, int(round(dur_sec * fps)))
    return fps, total


def video_ref_frame_index(
    video_path: str | Path,
    *,
    in_point_sec: float = 0.0,
    local_time_sec: float = 0.0,
    speed: float = 1.0,
) -> int:
    """Map timeline-local time to a source frame index."""
    fps, total = probe_video_fps_and_frame_count(video_path)
    sp = max(0.01, float(speed))
    source_t = max(0.0, float(in_point_sec) + float(local_time_sec) * sp)
    idx = int(round(source_t * fps))
    if total > 0:
        idx = min(max(0, idx), total - 1)
    return idx


def extract_video_frame_to_temp(
    video_path: str | Path,
    frame_index: int,
) -> str:
    """Extract one frame from a video as a temp PNG for SAM preview."""
    import av

    p = Path(video_path)
    if not p.is_file():
        raise ValueError(f"Video not found: {p}")
    idx = max(0, int(frame_index))
    dest = Path(tempfile.gettempdir()) / f"sam3_frame_{unique_suffix()}.png"
    with av.open(str(p)) as container:
        stream = container.streams.video[0]
        for i, frame in enumerate(container.decode(stream)):
            if i == idx:
                frame.to_image().save(dest)
                return str(dest)
    raise ValueError(f"Frame index {idx} out of range for {p.name}")


def run_sam3_segment_preview(
    *,
    image_abs_path: str,
    positive_coords: list[dict[str, Any]],
    negative_coords: list[dict[str, Any]] | None = None,
    text_prompt: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Run SAM3 mask preview; returns temp path to grayscale mask PNG."""
    result = _run_sam3_segment_service(
        job="image_mask",
        image_abs_path=image_abs_path,
        positive_coords=positive_coords,
        negative_coords=negative_coords,
        text_prompt=text_prompt,
        log_cb=log_cb,
    )
    tmp = Path(tempfile.gettempdir()) / f"sam3_preview_{unique_suffix()}"
    paths = _download_sam3_output_urls(result, tmp)
    return paths[0]


def run_sam3_segment_image_rgba(
    *,
    image_abs_path: str,
    positive_coords: list[dict[str, Any]],
    negative_coords: list[dict[str, Any]] | None = None,
    text_prompt: str | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Segment image to RGBA PNG cutout (transparent outside mask)."""
    result = _run_sam3_segment_service(
        job="image_rgba",
        image_abs_path=image_abs_path,
        positive_coords=positive_coords,
        negative_coords=negative_coords,
        text_prompt=text_prompt,
        log_cb=log_cb,
    )
    tmp = Path(tempfile.gettempdir()) / f"sam3_rgba_{unique_suffix()}"
    paths = _download_sam3_output_urls(result, tmp)
    return paths[0]


def composite_video_with_masks(
    *,
    video_abs_path: str,
    mask_paths: list[str],
    output_path: str | Path,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Composite source video frames with per-frame mask PNGs; write WebM VP9+alpha.
    """
    import av
    import numpy as np
    from PIL import Image

    def _log(msg: str) -> None:
        logger.info(msg)
        if log_cb:
            log_cb(msg)

    src = Path(video_abs_path)
    out = Path(output_path)
    if not src.is_file():
        raise ValueError(f"Video not found: {src}")
    if not mask_paths:
        raise ValueError("mask_paths is empty.")
    out.parent.mkdir(parents=True, exist_ok=True)

    in_container = av.open(str(src))
    in_stream = in_container.streams.video[0]
    fps = float(in_stream.average_rate or in_stream.base_rate or 24)
    src_w = in_stream.width
    src_h = in_stream.height
    _log(f"Compositing segment video {src_w}x{src_h} @ {fps:.2f} fps")

    out_container = av.open(str(out), mode="w", format="webm")
    out_stream = out_container.add_stream("libvpx-vp9", rate=fps)
    out_stream.width = src_w
    out_stream.height = src_h
    out_stream.pix_fmt = "yuva420p"
    out_stream.options = {
        "crf": "10",
        "b:v": "0",
        "deadline": "realtime",
        "cpu-used": "8",
        "row-mt": "1",
        "auto-alt-ref": "0",
    }

    frame_idx = 0
    with in_container, out_container:
        for packet in in_container.demux(in_stream):
            for av_frame in packet.decode():
                mask_path = mask_paths[min(frame_idx, len(mask_paths) - 1)]
                with Image.open(mask_path) as m_im:
                    mask = m_im.convert("L").resize((src_w, src_h))
                    alpha = np.asarray(mask, dtype=np.uint8)
                rgb = av_frame.to_ndarray(format="rgb24")
                rgba = np.dstack([rgb, alpha])
                out_frame = av.VideoFrame.from_ndarray(rgba, format="rgba")
                out_frame = out_frame.reformat(format="yuva420p")
                out_frame.pts = frame_idx
                out_frame.time_base = out_stream.codec_context.time_base
                for pkt in out_stream.encode(out_frame):
                    out_container.mux(pkt)
                frame_idx += 1
        for pkt in out_stream.encode():
            out_container.mux(pkt)

    duration = frame_idx / fps if fps > 0 else 0.0
    return {
        "absPath": str(out.resolve()),
        "width": src_w,
        "height": src_h,
        "fps": fps,
        "durationSec": duration,
        "frame_count": frame_idx,
    }


def run_sam3_segment_video(
    *,
    video_abs_path: str,
    positive_coords: list[dict[str, Any]],
    negative_coords: list[dict[str, Any]] | None = None,
    text_prompt: str | None = None,
    ref_frame_index: int = 0,
    output_path: str | Path | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Track segment across video frames; return WebM+alpha path and metadata."""
    result = _run_sam3_segment_service(
        job="video_masks",
        video_abs_path=video_abs_path,
        positive_coords=positive_coords,
        negative_coords=negative_coords,
        text_prompt=text_prompt,
        ref_frame_index=ref_frame_index,
        log_cb=log_cb,
    )
    tmp_masks = Path(tempfile.gettempdir()) / f"sam3_vmasks_{unique_suffix()}"
    mask_paths = _download_sam3_output_urls(result, tmp_masks)
    out = (
        Path(output_path)
        if output_path
        else Path(tempfile.gettempdir()) / f"sam3_vseg_{unique_suffix()}.webm"
    )
    try:
        return composite_video_with_masks(
            video_abs_path=video_abs_path,
            mask_paths=mask_paths,
            output_path=out,
            log_cb=log_cb,
        )
    finally:
        shutil.rmtree(tmp_masks, ignore_errors=True)


def segment_preview_mask_png_base64(
    *,
    clip_type: str,
    source_abs_path: str,
    positive_coords: list[dict[str, Any]],
    negative_coords: list[dict[str, Any]] | None = None,
    text_prompt: str | None = None,
    in_point_sec: float = 0.0,
    local_time_sec: float = 0.0,
    speed: float = 1.0,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Return base64 PNG mask (no data: prefix) for UI overlay."""
    kind = (clip_type or "image").strip().lower()
    image_path = source_abs_path
    temp_frame: str | None = None
    try:
        if kind == "video":
            ref_idx = video_ref_frame_index(
                source_abs_path,
                in_point_sec=in_point_sec,
                local_time_sec=local_time_sec,
                speed=speed,
            )
            temp_frame = extract_video_frame_to_temp(source_abs_path, ref_idx)
            image_path = temp_frame
        mask_path = run_sam3_segment_preview(
            image_abs_path=image_path,
            positive_coords=positive_coords,
            negative_coords=negative_coords,
            text_prompt=text_prompt,
            log_cb=log_cb,
        )
        raw = Path(mask_path).read_bytes()
        return base64.b64encode(raw).decode("ascii")
    finally:
        if temp_frame:
            Path(temp_frame).unlink(missing_ok=True)


def segment_to_timeline_clip(
    *,
    clip_type: str,
    source_abs_path: str,
    dest_dir: Path | str,
    positive_coords: list[dict[str, Any]],
    negative_coords: list[dict[str, Any]] | None = None,
    text_prompt: str | None = None,
    in_point_sec: float = 0.0,
    local_time_sec: float = 0.0,
    speed: float = 1.0,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Segment source media and persist into timeline ``clips/`` directory."""
    import uuid

    from PIL import Image

    kind = (clip_type or "image").strip().lower()
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    if kind == "video":
        ref_idx = video_ref_frame_index(
            source_abs_path,
            in_point_sec=in_point_sec,
            local_time_sec=local_time_sec,
            speed=speed,
        )
        out_path = dest / f"clip_{uuid.uuid4().hex}_seg.webm"
        info = run_sam3_segment_video(
            video_abs_path=source_abs_path,
            positive_coords=positive_coords,
            negative_coords=negative_coords,
            text_prompt=text_prompt,
            ref_frame_index=ref_idx,
            output_path=out_path,
            log_cb=log_cb,
        )
        return {
            "absPath": info["absPath"],
            "width": info.get("width") or 0,
            "height": info.get("height") or 0,
            "type": "video",
            "durationSec": info.get("durationSec") or 0.0,
        }

    rgba_temp = run_sam3_segment_image_rgba(
        image_abs_path=source_abs_path,
        positive_coords=positive_coords,
        negative_coords=negative_coords,
        text_prompt=text_prompt,
        log_cb=log_cb,
    )
    out_path = dest / f"clip_{uuid.uuid4().hex}_seg.png"
    shutil.copy2(rgba_temp, out_path)
    width = height = 0
    try:
        with Image.open(out_path) as im:
            width, height = int(im.width), int(im.height)
    except Exception:
        pass
    return {
        "absPath": str(out_path),
        "width": width,
        "height": height,
        "type": "image",
        "durationSec": 0.0,
    }


def create_sequence_from_sources(
    char_key: str,
    sequence_name: str,
    entries: list[dict[str, Any]],
) -> Path:
    """
    Create ``sequence/<sanitized_name>/`` with ``gallery/`` copies and manifest.

    Each entry: ``file_path`` (str abs path to copy).
    """
    name = sanitize_for_folder(sequence_name)
    if not name or name == "unnamed":
        raise ValueError("Sequence name is required.")
    character = get_character_paths(char_key)
    folder = character.sequence_dir(name)
    if (_sequence_manifest_path(char_key, name)).is_file():
        raise ValueError(f"Sequence {name!r} already exists.")
    ensure_dirs(folder, folder / "gallery", folder / "cells")
    gallery: list[dict[str, Any]] = []
    for e in entries:
        src = Path(str(e["file_path"]))
        if not src.is_file():
            raise ValueError(f"Missing file for sequence: {src}")
        ext = src.suffix.lower() or ".png"
        if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
            ext = ".png"
        gid = unique_suffix(12)
        dest_name = f"gal_{gid}{ext}"
        dest = folder / "gallery" / dest_name
        shutil.copy2(src, dest)
        rel = dest.resolve().relative_to(DEFAULT_STORAGE_ROOT.resolve())
        rel_str = str(rel).replace("\\", "/")
        gallery.append({"id": gid, "relPath": rel_str})
    manifest = {
        "version": 1,
        "fps": 24,
        "gallery": gallery,
        "frames": [],
        "previewAspect": "16:9",
        "timelineViewStep": 1,
    }
    with open(folder / SEQUENCE_MANIFEST_NAME, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return folder


def duplicate_sequence_asset(
    char_key: str,
    sequence_name: str,
    source_abs: str,
    *,
    subfolder: str,
) -> str:
    """
    Copy ``source_abs`` into ``sequence/<name>/<subfolder>/`` with a unique name.
    ``subfolder`` must be ``gallery`` or ``cells``.
    Returns storage-relative path string.
    """
    if subfolder not in ("gallery", "cells"):
        raise ValueError("subfolder must be gallery or cells")
    src = Path(source_abs).resolve()
    root = DEFAULT_STORAGE_ROOT.resolve()
    if not src.is_file():
        raise ValueError("Source file not found.")
    if root != src and root not in src.parents:
        raise ValueError("Invalid source path")
    seq_folder = sequence_folder_path(char_key, sequence_name)
    if not seq_folder.is_dir():
        raise ValueError("Sequence folder not found.")
    ext = src.suffix.lower() or ".png"
    if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
        ext = ".png"
    nid = unique_suffix(12)
    prefix = "gal_" if subfolder == "gallery" else "cell_"
    dest = seq_folder / subfolder / f"{prefix}{nid}{ext}"
    ensure_dirs(dest.parent)
    shutil.copy2(src, dest)
    rel = dest.resolve().relative_to(root)
    return str(rel).replace("\\", "/")


def probe_audio_meta(path: Path | str) -> dict[str, Any]:
    """Return ``{durationSec}`` for an audio file via PyAV."""
    import av

    p = Path(path)
    duration_sec = 0.0
    with av.open(str(p)) as container:
        if container.duration:
            duration_sec = float(container.duration) / float(av.time_base)
        else:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is not None and stream.duration is not None and stream.time_base is not None:
                duration_sec = float(stream.duration) * float(stream.time_base)
    return {"durationSec": round(max(duration_sec, 0.0), 4)}


def run_sound_gen(
    *,
    prompt: str,
    duration_sec: float = 30.0,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Generate sound via Stable Audio Open 1.0; returns local path or URL."""
    effective = (prompt or "").strip()
    if not effective:
        raise ValueError("prompt is required for sound generation.")
    duration_sec = min(max(float(duration_sec), 1.0), 47.6)

    body = _run_service_testmode(
        "services.sound_gen_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--prompt",
            effective,
            "--duration",
            str(duration_sec),
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    results = body.get("results") or []
    for r in results:
        if isinstance(r, dict):
            ref = r.get("url") or r.get("local_path")
            if isinstance(ref, str) and ref:
                return ref
    raise RuntimeError("Sound generation produced no output.")


def run_music_gen(
    *,
    tags: str,
    lyrics: str = "",
    duration_sec: float = 120.0,
    bpm: int = 120,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Generate music via ACE-Step 1.5; returns local path or URL."""
    effective_tags = (tags or "").strip()
    if not effective_tags:
        raise ValueError("tags are required for music generation.")

    body = _run_service_testmode(
        "services.music_gen_ai_service.serverless",
        [
            "--test-mode",
            "--enable-default",
            "--default-port",
            str(COMFY_PORT),
            "--tags",
            effective_tags,
            "--lyrics",
            lyrics or "",
            "--duration",
            str(float(duration_sec)),
            "--bpm",
            str(int(bpm)),
        ],
        log_cb=log_cb,
    )
    if body.get("error"):
        raise RuntimeError(str(body["error"]))

    results = body.get("results") or []
    for r in results:
        if isinstance(r, dict):
            ref = r.get("url") or r.get("local_path")
            if isinstance(ref, str) and ref:
                return ref
    raise RuntimeError("Music generation produced no output.")


def _audio_ref_to_local(ref: str, log_cb: Callable[[str], None] | None = None) -> str:
    if ref and Path(ref).is_file():
        return str(Path(ref).resolve())
    if ref and (ref.startswith("http://") or ref.startswith("https://")):
        dest = Path(tempfile.gettempdir()) / f"aud_{unique_suffix()}.mp3"
        download_url_to_file(ref, dest)
        return str(dest)
    raise RuntimeError(f"Could not resolve audio file: {ref!r}")


def generate_reference_audio(
    *,
    mode: str,
    prompt: str = "",
    style: str = "",
    lyrics: str = "",
    duration_sec: float = 120.0,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Generate sound or music and register it in the global audio gallery."""
    from services import audio_reference_storage

    m = (mode or "audio").strip().lower()
    if m == "music":
        tags = (style or "").strip()
        lyric_text = lyrics or ""
        if not tags:
            raise ValueError("Music style description is required.")
        ref = run_music_gen(
            tags=tags,
            lyrics=lyric_text,
            duration_sec=duration_sec,
            log_cb=log_cb,
        )
    else:
        tags = (prompt or "").strip()
        if not tags:
            raise ValueError("Audio prompt is required.")
        sound_dur = min(max(float(duration_sec), 1.0), 47.6)
        ref = run_sound_gen(
            prompt=tags,
            duration_sec=sound_dur,
            log_cb=log_cb,
        )

    local = _audio_ref_to_local(ref, log_cb=log_cb)
    meta = probe_audio_meta(local)
    dur = meta.get("durationSec") or float(duration_sec)
    entry = audio_reference_storage.add_audio_item(
        local,
        mode=m,
        tags=tags,
        label=tags[:80],
    )
    return {
        "item": {
            "id": entry["id"],
            "relPath": entry["relPath"],
            "mode": entry.get("mode"),
            "tags": entry.get("tags"),
            **({"label": entry["label"]} if entry.get("label") else {}),
        },
        "durationSec": dur,
    }


def import_audio_to_timeline_clip(
    source_abs_path: Path | str,
    dest_dir: Path | str,
) -> dict[str, Any]:
    """Copy an audio file into ``dest_dir`` and return ``{absPath, durationSec}``."""
    import shutil
    import uuid

    src = Path(source_abs_path)
    if not src.is_file():
        raise ValueError(f"Audio not found: {source_abs_path}")
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower() or ".mp3"
    out_path = dest / f"clip_{uuid.uuid4().hex}{ext}"
    shutil.copy2(src, out_path)
    meta = probe_audio_meta(out_path)
    return {
        "absPath": str(out_path.resolve()),
        "durationSec": meta.get("durationSec") or 0.0,
    }
