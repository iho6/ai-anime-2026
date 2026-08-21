"""
Kimodo editable install helpers (MotionCorrection C extension).

Requires system packages: cmake, build-essential, python{X.Y}-dev matching the
active interpreter. CMake must build against the venv Python, not system python.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

from services.kimodo_build_cmake import (
    kimodo_build_packages,
    python_cmake_args,
    python_dev_headers_ready,
    require_python_dev_headers,
)

_REPO_ROOT = Path(__file__).resolve().parents[1]
_KIMODO_DIR = _REPO_ROOT / "kimodo"
_PATCHES_DIR = _REPO_ROOT / "patches" / "kimodo"
_KIMODO_REQUIREMENTS = _PATCHES_DIR / "kimodo-requirements.txt"
_MOTION_CORRECTION_PKG_DIR = (
    _KIMODO_DIR / "MotionCorrection" / "python" / "motion_correction"
)

_KIMODO_OVERLAY_FILES = (
    "build_cmake.py",
    "setup.py",
    "MANIFEST.in",
    "MotionCorrection/setup.py",
    "kimodo/scripts/run_text_encoder_server.py",
    "kimodo/assets/__init__.py",
)

_KIMODO_OVERLAY_REMOVALS = (
    "kimodo/assets.py",
)


def kimodo_cmake_args() -> list[str]:
    """Backward-compatible alias for python_cmake_args()."""
    return python_cmake_args()


def apply_kimodo_patches(
    kimodo_dir: Path,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Copy parent-repo overlays into kimodo submodule (CMake + runtime fixes)."""
    for rel in _KIMODO_OVERLAY_FILES:
        src = _PATCHES_DIR / rel
        dst = kimodo_dir / rel
        if not src.is_file():
            raise RuntimeError(f"Missing kimodo overlay: {src}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if log_cb:
            log_cb(f"Applied kimodo overlay: {rel}")
    for rel in _KIMODO_OVERLAY_REMOVALS:
        dst = kimodo_dir / rel
        if dst.is_file():
            dst.unlink()
            if log_cb:
                log_cb(f"Removed conflicting kimodo file: {rel}")


def apply_kimodo_cmake_patches(
    kimodo_dir: Path,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Backward-compatible alias for apply_kimodo_patches."""
    apply_kimodo_patches(kimodo_dir, log_cb=log_cb)


def motion_correction_extension_files(kimodo_dir: Path | None = None) -> list[Path]:
    """Built extension modules under the kimodo tree, if any.

    Linux builds produce ``*.so``; Windows editable installs produce ``*.pyd``
    (sometimes accompanied by a sibling ``*.dll``).
    """
    pkg_dir = (
        (kimodo_dir or _KIMODO_DIR)
        / "MotionCorrection"
        / "python"
        / "motion_correction"
    )
    if not pkg_dir.is_dir():
        return []
    found: list[Path] = []
    for pattern in (
        "_motion_correction*.so",
        "_motion_correction*.pyd",
        "_motion_correction*.dll",
    ):
        found.extend(pkg_dir.glob(pattern))
    # De-dupe while preserving order (same stem may match multiple globs).
    seen: set[Path] = set()
    out: list[Path] = []
    for p in sorted(found, key=lambda x: x.name):
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _subprocess_import_status() -> tuple[bool, list[str]]:
    """Import kimodo + motion_correction in a fresh interpreter from a neutral cwd.

    Editable installs register packages via .pth files that site.py only reads at
    interpreter startup, so an in-process import would miss a just-installed package.
    A neutral cwd also avoids the repo's kimodo/ dir resolving as a namespace package.
    """
    script = (
        "import importlib, sys\n"
        "ok = True\n"
        "for name in ('kimodo', 'motion_correction'):\n"
        "    try:\n"
        "        m = importlib.import_module(name)\n"
        "        if getattr(m, '__file__', None) is None and not getattr(m, '__path__', None):\n"
        "            raise ImportError('namespace-only import (package not found)')\n"
        "        print(f'{name}: import OK')\n"
        "    except Exception as exc:\n"
        "        ok = False\n"
        "        print(f'{name}: import failed ({type(exc).__name__}: {exc})')\n"
        "sys.exit(0 if ok else 1)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tempfile.gettempdir(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if proc.returncode != 0 and proc.stderr and not lines:
        lines.append(proc.stderr.strip())
    return proc.returncode == 0, lines


def _kimodo_import_status(kimodo_dir: Path | None = None) -> tuple[bool, str]:
    """Try kimodo + motion_correction imports; report per-module errors and extension state."""
    ok, lines = _subprocess_import_status()

    ext_files = motion_correction_extension_files(kimodo_dir)
    if ext_files:
        lines.append(
            "motion_correction extension: " + ", ".join(p.name for p in ext_files)
        )
    else:
        ok = False
        pkg = (
            (kimodo_dir or _KIMODO_DIR)
            / "MotionCorrection"
            / "python"
            / "motion_correction"
        )
        lines.append(
            "motion_correction extension: missing "
            f"(no _motion_correction*.so/.pyd under {pkg})"
        )

    return ok, "\n".join(lines)


def _env_flag(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
        "on",
    }


def _portable_toolchain_roots() -> list[Path]:
    """Candidate roots for portable CMake/MinGW living on the project drive."""
    roots: list[Path] = []
    env_root = (os.environ.get("ANIME2026_TOOLCHAINS") or "").strip()
    if env_root:
        roots.append(Path(env_root))
    # Prefer H:\Animation\toolchains when the repo lives under H:\Animation\...
    try:
        anim = _REPO_ROOT.parents[0]  # .../Animation/anime2026_refactored → Animation
        roots.append(anim / "toolchains")
    except IndexError:
        pass
    roots.append(_REPO_ROOT / "toolchains")
    # De-dupe while preserving order
    seen: set[str] = set()
    out: list[Path] = []
    for r in roots:
        key = str(r.resolve()) if r.exists() else str(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _prepend_portable_toolchains(
    *,
    log_cb: Callable[[str], None] | None = None,
) -> bool:
    """Put on-drive CMake/MinGW ahead of PATH when present (no Program Files needed)."""
    if os.name != "nt":
        return False
    prepend: list[str] = []
    found_root: Path | None = None
    for root in _portable_toolchain_roots():
        cmake_bin = root / "cmake" / "bin"
        mingw_bin = root / "mingw64" / "bin"
        if (cmake_bin / "cmake.exe").is_file():
            prepend.append(str(cmake_bin))
            found_root = root
        if (mingw_bin / "g++.exe").is_file():
            prepend.append(str(mingw_bin))
            found_root = root
        if prepend:
            break
    if not prepend:
        return False
    path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join(prepend + ([path] if path else []))
    # MotionCorrection overlay picks MinGW Makefiles when g++ is visible.
    os.environ.setdefault("CMAKE_GENERATOR", "MinGW Makefiles")
    if log_cb and found_root is not None:
        log_cb(f"Using portable toolchain on {found_root}")
    return True


def _cmake_on_path() -> bool:
    """True if cmake is usable without installing (PATH refresh + common dirs on Windows)."""
    if shutil.which("cmake"):
        return True
    if os.name == "nt":
        _prepend_portable_toolchains()
        if shutil.which("cmake"):
            return True
        _refresh_windows_path()
        if shutil.which("cmake"):
            return True
        if _prepend_known_cmake_dirs() and shutil.which("cmake"):
            return True
    return False


def _force_kimodo_build() -> bool:
    return _env_flag("ANIME2026_FORCE_KIMODO_BUILD")


def _skip_kimodo() -> bool:
    return _env_flag("ANIME2026_SKIP_KIMODO")


def _kimodo_build_failed_sentinel() -> Path:
    return _REPO_ROOT / ".anime2026_kimodo_build_failed"


def _kimodo_build_failed_previously() -> bool:
    return _kimodo_build_failed_sentinel().is_file()


def _mark_kimodo_build_failed(detail: str) -> None:
    try:
        _kimodo_build_failed_sentinel().write_text(
            (detail or "kimodo build failed").strip()[:4000] + "\n",
            encoding="utf-8",
        )
    except OSError:
        pass


def _clear_kimodo_build_failed() -> None:
    try:
        _kimodo_build_failed_sentinel().unlink(missing_ok=True)
    except OSError:
        pass


def kimodo_importable() -> bool:
    ok, _ = _kimodo_import_status()
    return ok


def _winget_exe_usable(exe: str) -> bool:
    """True when ``exe`` runs ``winget --version`` successfully (rejects dead App aliases)."""
    try:
        path = Path(exe)
        if path.is_file() and path.stat().st_size == 0:
            # Common WindowsApps stub; may still work via execution alias — probe below.
            pass
        proc = subprocess.run(
            [exe, "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        return proc.returncode == 0 and bool((proc.stdout or proc.stderr or "").strip())
    except Exception:
        return False


def _resolve_winget_exe() -> str | None:
    """Locate a working winget.exe (PATH, WindowsApps, or ``where``)."""
    candidates: list[str] = []
    which = shutil.which("winget")
    if which:
        candidates.append(which)
    local_app = (os.environ.get("LOCALAPPDATA") or "").strip()
    if local_app:
        candidates.append(
            str(Path(local_app) / "Microsoft" / "WindowsApps" / "winget.exe")
        )
    # Desktop App Installer package location varies; ask where.exe for extras.
    try:
        proc = subprocess.run(
            ["where.exe", "winget"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        if proc.returncode == 0:
            for line in (proc.stdout or "").splitlines():
                line = line.strip()
                if line:
                    candidates.append(line)
    except Exception:
        pass

    seen: set[str] = set()
    for cand in candidates:
        key = cand.lower()
        if key in seen:
            continue
        seen.add(key)
        if _winget_exe_usable(cand):
            return cand
    return None


def _vswhere_exe() -> str | None:
    pf86 = os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"
    candidate = (
        Path(pf86)
        / "Microsoft Visual Studio"
        / "Installer"
        / "vswhere.exe"
    )
    if candidate.is_file():
        return str(candidate)
    return shutil.which("vswhere")


def _msvc_available() -> bool:
    """True if MSVC C++ toolchain looks usable (cl.exe or VS Build Tools via vswhere)."""
    if os.name == "nt":
        _prepend_portable_toolchains()
    if shutil.which("cl"):
        return True
    if shutil.which("g++"):
        # MinGW is accepted by the MotionCorrection overlay when g++ is present.
        return True
    vswhere = _vswhere_exe()
    if not vswhere:
        return False
    try:
        proc = subprocess.run(
            [
                vswhere,
                "-latest",
                "-products",
                "*",
                "-requires",
                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                "-property",
                "installationPath",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        return proc.returncode == 0 and bool((proc.stdout or "").strip())
    except Exception:
        return False


def _cxx_toolchain_available() -> bool:
    return _msvc_available()


def _kimodo_pip_install_env() -> dict[str, str]:
    if os.name == "nt":
        _prepend_portable_toolchains()
    env = os.environ.copy()
    env["KIMODO_TARGET_PYTHON"] = sys.executable
    env["KIMODO_CMAKE_ARGS"] = " ".join(python_cmake_args())
    env["SKIP_MOTION_CORRECTION_IN_SETUP"] = "1"
    return env


def _kimodo_pip_install_cmd(kimodo_dir: Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-e",
        str(kimodo_dir),
        "--no-build-isolation",
        "--no-deps",
    ]


def _motion_correction_pip_install_cmd(kimodo_dir: Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-e",
        str(kimodo_dir / "MotionCorrection"),
        "--no-build-isolation",
        "--no-deps",
    ]


def _kimodo_requirements_install_cmd() -> list[str]:
    return [sys.executable, "-m", "pip", "install", "-r", str(_KIMODO_REQUIREMENTS)]


def kimodo_runtime_deps_ready() -> bool:
    """True when primary kimodo runtime deps (gradio) are importable."""
    return importlib.util.find_spec("gradio") is not None


def ensure_kimodo_runtime_deps(
    *,
    run_command: Callable[..., None] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Install ``kimodo-requirements.txt`` when gradio (or peers) are missing.

    Safe to call from text-encoder startup without rebuilding MotionCorrection.
    """
    if kimodo_runtime_deps_ready():
        if log_cb:
            log_cb("kimodo runtime deps already present (gradio)")
        return
    if log_cb:
        log_cb("Installing kimodo runtime dependencies…")
    _run_pip_install(
        _kimodo_requirements_install_cmd(),
        run_command=run_command,
        log_cb=log_cb,
        env=os.environ.copy(),
    )


def _run_pip_install(
    cmd: list[str],
    *,
    run_command: Callable[..., None] | None,
    log_cb: Callable[[str], None] | None,
    env: dict[str, str],
) -> None:
    if run_command is not None:
        run_command(cmd, cwd=_REPO_ROOT, log_cb=log_cb, env=env)
        return
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "pip install failed").strip()
        raise RuntimeError(_kimodo_install_failure_message(err))


def _run_kimodo_editable_install(
    kimodo_dir: Path,
    *,
    run_command: Callable[..., None] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Apply patches, editable-install kimodo + deps + motion_correction, restore cu128 torch.

    Runtime requirements are installed **before** MotionCorrection so a C-extension
    build failure cannot strand the venv without gradio (needed by the text encoder).
    """
    apply_kimodo_patches(kimodo_dir, log_cb=log_cb)
    env = _kimodo_pip_install_env()
    if log_cb:
        log_cb("Installing kimodo (editable, Python package only)…")
    _run_pip_install(
        _kimodo_pip_install_cmd(kimodo_dir),
        run_command=run_command,
        log_cb=log_cb,
        env=env,
    )
    if log_cb:
        log_cb("Installing kimodo runtime dependencies…")
    _run_pip_install(
        _kimodo_requirements_install_cmd(),
        run_command=run_command,
        log_cb=log_cb,
        env=os.environ.copy(),
    )
    if log_cb:
        log_cb("Installing motion_correction (editable C extension)…")
    _run_pip_install(
        _motion_correction_pip_install_cmd(kimodo_dir),
        run_command=run_command,
        log_cb=log_cb,
        env=env,
    )
    from services.pytorch_setup import ensure_pytorch_stack

    ensure_pytorch_stack(log_cb=log_cb)


def _build_deps_apt_cmd() -> list[str]:
    return ["apt-get", "install", "-y", *kimodo_build_packages()]


def _apt_runner() -> list[str]:
    """Return prefix for apt-get (empty when root, else sudo if available)."""
    if os.name != "posix" or not sys.platform.startswith("linux"):
        return []
    if os.geteuid() == 0:
        return []
    if shutil.which("sudo"):
        return ["sudo"]
    return []


def _kimodo_build_deps_hint() -> str:
    """Platform-specific instructions for MotionCorrection build tools."""
    if sys.platform.startswith("linux"):
        packages = " ".join(kimodo_build_packages())
        return f"Install manually: sudo apt-get install -y {packages}"
    if os.name == "nt":
        return (
            "On Windows: CMake + Visual Studio 2022 Build Tools (C++ workload) are required "
            "to compile motion_correction. Prefer: "
            "powershell -ExecutionPolicy Bypass -File scripts\\install_kimodo_windows.ps1 "
            "(or set ANIME2026_FORCE_KIMODO_BUILD=1 and re-run Launch). "
            "Manual: winget install Kitware.CMake --scope user; "
            "winget install Microsoft.VisualStudio.2022.BuildTools "
            "--override \"--wait --passive --add Microsoft.VisualStudio.Workload.VCTools "
            "--includeRecommended\". Use a full CPython with include\\Python.h "
            f"(active interpreter: {sys.executable}). "
            "Skip motion entirely with ANIME2026_SKIP_KIMODO=1."
        )
    return "Install cmake and Python development headers for this platform."


def _require_cmake() -> None:
    if shutil.which("cmake"):
        return
    raise RuntimeError(
        "cmake not found on PATH (required to build kimodo motion_correction).\n"
        + _kimodo_build_deps_hint()
    )


def _refresh_windows_path() -> None:
    """Rebuild PATH from Machine + User registry (pick up winget installs in-process)."""
    if os.name != "nt":
        return
    try:
        import winreg
    except ImportError:
        return
    parts: list[str] = []
    for hive, subkey in (
        (
            winreg.HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
        (winreg.HKEY_CURRENT_USER, "Environment"),
    ):
        try:
            with winreg.OpenKey(hive, subkey) as key:
                val, _ = winreg.QueryValueEx(key, "Path")
                if val:
                    parts.append(str(val))
        except OSError:
            pass
    if parts:
        os.environ["PATH"] = ";".join(parts)


def _prepend_known_cmake_dirs() -> bool:
    """If cmake.exe exists in common install locations, prepend that dir to PATH."""
    candidates: list[Path] = []
    local_app = (os.environ.get("LOCALAPPDATA") or "").strip()
    if local_app:
        candidates.append(Path(local_app) / "Programs" / "CMake" / "bin")
    candidates.append(
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "CMake" / "bin"
    )
    candidates.append(
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        / "CMake"
        / "bin"
    )
    for d in candidates:
        exe = d / "cmake.exe"
        if exe.is_file():
            os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
            return True
    return False


def _run_winget(
    args: list[str],
    *,
    log_cb: Callable[[str], None] | None = None,
) -> subprocess.CompletedProcess[str]:
    winget = _resolve_winget_exe()
    if not winget:
        raise RuntimeError(
            "winget is unavailable (PATH / WindowsApps alias failed).\n"
            + _kimodo_build_deps_hint()
        )
    cmd = [winget, *args]
    if log_cb:
        log_cb("$ " + " ".join(cmd))
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if log_cb and proc.stdout:
        for line in proc.stdout.splitlines():
            if line.strip():
                log_cb(line)
    if log_cb and proc.stderr:
        for line in proc.stderr.splitlines():
            if line.strip():
                log_cb(line)
    return proc


def _ensure_cmake_windows(
    *,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Install CMake via user-scope winget when missing (Windows only)."""
    if os.name != "nt":
        return
    if _cmake_on_path():
        if log_cb:
            log_cb(f"Found cmake on PATH: {shutil.which('cmake')}")
        return

    if log_cb:
        log_cb("cmake not found; installing Kitware.CMake via winget (user scope)…")
    proc = _run_winget(
        [
            "install",
            "-e",
            "--id",
            "Kitware.CMake",
            "--scope",
            "user",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ],
        log_cb=log_cb,
    )

    _refresh_windows_path()
    if not shutil.which("cmake"):
        _prepend_known_cmake_dirs()

    if _cmake_on_path():
        if log_cb:
            log_cb(f"cmake ready: {shutil.which('cmake')}")
        return

    detail = (proc.stderr or proc.stdout or "").strip()
    raise RuntimeError(
        "cmake still not on PATH after winget install of Kitware.CMake "
        f"(exit {proc.returncode}). Open a new terminal and retry, or install CMake manually.\n"
        f"{detail}\n"
        + _kimodo_build_deps_hint()
    )


def _ensure_msvc_windows(
    *,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Ensure MSVC (or MinGW g++) is available; attempt VS 2022 Build Tools via winget."""
    if os.name != "nt":
        return
    if _cxx_toolchain_available():
        if log_cb:
            which_cl = shutil.which("cl") or shutil.which("g++") or "vswhere-detected"
            log_cb(f"C++ toolchain available ({which_cl})")
        return

    if log_cb:
        log_cb(
            "MSVC/MinGW not found; installing Visual Studio 2022 Build Tools "
            "(C++ workload) via winget. UAC/admin approval may be required…"
        )
    # Machine-scope Build Tools; often needs elevation.
    override = (
        "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools "
        "--includeRecommended"
    )
    try:
        proc = _run_winget(
            [
                "install",
                "-e",
                "--id",
                "Microsoft.VisualStudio.2022.BuildTools",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--override",
                override,
            ],
            log_cb=log_cb,
        )
    except RuntimeError as exc:
        raise RuntimeError(
            "C++ toolchain missing and winget could not install VS Build Tools.\n"
            "Install manually from "
            "https://visualstudio.microsoft.com/visual-cpp-build-tools/ "
            "(workload: Desktop development with C++), then set "
            "ANIME2026_FORCE_KIMODO_BUILD=1 and retry.\n"
            + _kimodo_build_deps_hint()
        ) from exc

    _refresh_windows_path()
    if _cxx_toolchain_available():
        if log_cb:
            log_cb("C++ toolchain ready after Build Tools install")
        return

    detail = (proc.stderr or proc.stdout or "").strip()
    raise RuntimeError(
        "C++ toolchain still missing after winget install of VS 2022 Build Tools "
        f"(exit {proc.returncode}). Approve UAC if prompted, open a new terminal, "
        "or install Build Tools manually:\n"
        "https://visualstudio.microsoft.com/visual-cpp-build-tools/\n"
        f"{detail}\n"
        + _kimodo_build_deps_hint()
    )


def _run_apt_build_deps(*, log_cb: Callable[[str], None] | None = None) -> None:
    if not sys.platform.startswith("linux") or not shutil.which("apt-get"):
        return
    if os.geteuid() != 0 and not shutil.which("sudo"):
        return
    runner = _apt_runner()
    cmd = [*runner, *_build_deps_apt_cmd()]
    if log_cb:
        log_cb("$ " + " ".join(cmd))
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        capture_output=not log_cb,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        out = (proc.stderr or proc.stdout or "apt-get install failed").strip()
        raise RuntimeError(
            f"Failed to install kimodo build dependencies: {out}\n"
            + _kimodo_build_deps_hint()
        )
    if log_cb and proc.stdout:
        for line in proc.stdout.splitlines():
            log_cb(line)


def ensure_kimodo_build_deps(
    *,
    run_command: Callable[..., None],
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Ensure tools needed to compile motion_correction (apt on Linux only)."""
    linux_apt = sys.platform.startswith("linux") and bool(shutil.which("apt-get"))

    if linux_apt:
        packages = kimodo_build_packages()
        if log_cb:
            log_cb(f"Ensuring kimodo build deps (apt): {', '.join(packages)}")
        try:
            run_command(
                [*_apt_runner(), *_build_deps_apt_cmd()],
                cwd=_REPO_ROOT,
                log_cb=log_cb,
            )
        except RuntimeError as exc:
            raise RuntimeError(
                "Failed to install kimodo build dependencies. "
                + _kimodo_build_deps_hint()
            ) from exc
    else:
        if log_cb:
            log_cb(
                "Ensuring kimodo build deps (non-apt): cmake + C++ toolchain + Python headers"
            )
        # Windows: prefer on-drive portable CMake/MinGW, else winget.
        if os.name == "nt":
            _prepend_portable_toolchains(log_cb=log_cb)
            _ensure_cmake_windows(log_cb=log_cb)
            _ensure_msvc_windows(log_cb=log_cb)

    # Never call apt-get here on Windows; verify local toolchain.
    _require_cmake()
    if os.name == "nt" and not _cxx_toolchain_available():
        raise RuntimeError(
            "C++ toolchain (MSVC or MinGW g++) required to build motion_correction.\n"
            + _kimodo_build_deps_hint()
        )
    require_python_dev_headers()


def _run_git_clone(
    cmd: list[str],
    *,
    run_command: Callable[..., None] | None,
    log_cb: Callable[[str], None] | None,
) -> None:
    if run_command is not None:
        run_command(cmd, cwd=_REPO_ROOT, log_cb=log_cb)
        return
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "git clone failed").strip()
        raise RuntimeError(f"Failed to clone kimodo: {err}")


def _kimodo_source_ready(kimodo_dir: Path) -> bool:
    """True when ``kimodo/`` has upstream sources (not just applied overlays).

    Overlays copy ``setup.py`` into an empty gitlink, so presence of ``setup.py``
    alone is not enough — ``kimodo.model`` must exist for the text encoder.
    """
    return (kimodo_dir / "kimodo" / "model").is_dir() and (
        (kimodo_dir / "setup.py").is_file() or (kimodo_dir / "pyproject.toml").is_file()
    )


def _ensure_kimodo_repo(
    *,
    run_command: Callable[..., None] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> Path:
    kimodo_dir = _KIMODO_DIR
    if _kimodo_source_ready(kimodo_dir):
        return kimodo_dir

    if kimodo_dir.is_dir():
        if log_cb:
            log_cb(
                "Kimodo checkout incomplete (missing kimodo/model); "
                "removing stub and re-cloning nv-tlabs/kimodo…"
            )
        bak = kimodo_dir.with_name(kimodo_dir.name + ".incomplete_bak")
        if bak.exists():
            shutil.rmtree(bak, ignore_errors=True)
        try:
            kimodo_dir.rename(bak)
        except OSError:
            shutil.rmtree(kimodo_dir, ignore_errors=True)
            bak = None  # type: ignore[assignment]
    else:
        bak = None

    if log_cb:
        log_cb("Cloning nv-tlabs/kimodo…")
    try:
        _run_git_clone(
            ["git", "clone", "https://github.com/nv-tlabs/kimodo.git", str(kimodo_dir)],
            run_command=run_command,
            log_cb=log_cb,
        )
    except Exception:
        # Restore previous tree if clone failed and we moved it aside.
        if bak is not None and bak.exists() and not kimodo_dir.exists():
            try:
                bak.rename(kimodo_dir)
            except OSError:
                pass
        raise

    if bak is not None and bak.exists():
        shutil.rmtree(bak, ignore_errors=True)

    if not _kimodo_source_ready(kimodo_dir):
        raise RuntimeError(
            "Cloned kimodo but kimodo/model is still missing — check the clone."
        )
    return kimodo_dir


def kimodo_git_update_requested() -> bool:
    """True when the user opted into updating Kimodo via ``KIMODO_GIT_UPDATE=1``.

    Updating Kimodo is never automatic: the default install path early-returns when
    Kimodo already imports. This opt-in flag is the only way to re-pull + reinstall.
    """
    return os.environ.get("KIMODO_GIT_UPDATE", "").strip().lower() in {"1", "true", "yes"}


def update_kimodo_repo(
    kimodo_dir: Path,
    *,
    run_command: Callable[..., None] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Fast-forward the Kimodo checkout, then re-apply overlays.

    Opt-in only (see ``kimodo_git_update_requested``). Uses ``--ff-only`` so a dirty
    or diverged tree fails loudly instead of producing a bad merge. Overlays are
    re-applied immediately so upstream ``setup.py`` / ``build_cmake.py`` never linger
    un-patched before the editable reinstall.
    """
    if not (kimodo_dir / ".git").is_dir():
        if log_cb:
            log_cb("Kimodo is not a git checkout; skipping update.")
        return
    if log_cb:
        log_cb("Updating Kimodo (git fetch + pull --ff-only)…")
    _run_git_clone(
        ["git", "-C", str(kimodo_dir), "fetch", "--all", "--prune"],
        run_command=run_command,
        log_cb=log_cb,
    )
    _run_git_clone(
        ["git", "-C", str(kimodo_dir), "pull", "--ff-only"],
        run_command=run_command,
        log_cb=log_cb,
    )
    apply_kimodo_patches(kimodo_dir, log_cb=log_cb)


def _kimodo_install_failure_message(err: str) -> str:
    return (
        f"{err}\n"
        f"Kimodo builds MotionCorrection against {sys.executable} (not system python). "
        f"{_kimodo_build_deps_hint()}"
    )


def _kimodo_post_install_failure_message(kimodo_dir: Path) -> str:
    _, status = _kimodo_import_status(kimodo_dir)
    return (
        "kimodo install finished but motion_correction is not importable.\n"
        f"{status}\n"
        f"{_kimodo_build_deps_hint()}"
    )


def ensure_kimodo_installed(
    *,
    run_command: Callable[..., None],
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Editable-install kimodo with MotionCorrection when imports are missing.

    Default behaviour: early-return when kimodo already imports. When
    ``KIMODO_GIT_UPDATE=1`` is set, the checkout is fast-forwarded and the full
    guarded reinstall runs even if kimodo currently imports.

    Windows bootstrap (when not importable): ensure cmake + MSVC (via winget if
    needed), clone empty gitlink, editable install, verify. A failure sentinel
    (``.anime2026_kimodo_build_failed``) prevents retrying a broken toolchain on
    every warm start unless ``ANIME2026_FORCE_KIMODO_BUILD=1``. Skip entirely with
    ``ANIME2026_SKIP_KIMODO=1``.
    """
    if _skip_kimodo():
        if log_cb:
            log_cb("ANIME2026_SKIP_KIMODO=1 — skipping kimodo install")
        return

    if kimodo_git_update_requested():
        if log_cb:
            log_cb("KIMODO_GIT_UPDATE=1 — updating and reinstalling kimodo…")
        try:
            ensure_kimodo_build_deps(run_command=run_command, log_cb=log_cb)
            kimodo_dir = _ensure_kimodo_repo(run_command=run_command, log_cb=log_cb)
            update_kimodo_repo(kimodo_dir, run_command=run_command, log_cb=log_cb)
            _run_kimodo_editable_install(
                kimodo_dir, run_command=run_command, log_cb=log_cb
            )
            if not kimodo_importable():
                raise RuntimeError(_kimodo_post_install_failure_message(kimodo_dir))
            _clear_kimodo_build_failed()
        except Exception as exc:
            _mark_kimodo_build_failed(str(exc))
            raise
        return

    if kimodo_importable():
        if log_cb:
            log_cb("kimodo + motion_correction already importable")
        _clear_kimodo_build_failed()
        return

    if _kimodo_build_failed_previously() and not _force_kimodo_build():
        prev = ""
        try:
            prev = _kimodo_build_failed_sentinel().read_text(encoding="utf-8").strip()
        except OSError:
            pass
        raise RuntimeError(
            "Previous kimodo build failed; skipping retry "
            "(motion features optional). Set ANIME2026_FORCE_KIMODO_BUILD=1 "
            "or run scripts\\install_kimodo_windows.ps1 to retry.\n"
            + (f"Last error: {prev}\n" if prev else "")
            + _kimodo_build_deps_hint()
        )

    try:
        ensure_kimodo_build_deps(run_command=run_command, log_cb=log_cb)
        kimodo_dir = _ensure_kimodo_repo(run_command=run_command, log_cb=log_cb)
        _run_kimodo_editable_install(kimodo_dir, run_command=run_command, log_cb=log_cb)
        if not kimodo_importable():
            raise RuntimeError(_kimodo_post_install_failure_message(kimodo_dir))
        _clear_kimodo_build_failed()
    except Exception as exc:
        _mark_kimodo_build_failed(str(exc))
        raise


def pip_install_kimodo_editable() -> None:
    """Standalone pip install for scripts/manual use (attempts apt build deps on Linux)."""
    if kimodo_importable():
        return

    kimodo_dir = _ensure_kimodo_repo()

    if not python_dev_headers_ready():
        _run_apt_build_deps()
    require_python_dev_headers()
    _run_kimodo_editable_install(kimodo_dir)
    if not kimodo_importable():
        raise RuntimeError(_kimodo_post_install_failure_message(kimodo_dir))
