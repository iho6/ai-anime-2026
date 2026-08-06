#!/usr/bin/env bash
set -euo pipefail

API_HOST="127.0.0.1"
API_PORT="8000"
FRONTEND_PORT="3000"
VENV_DIR=".venv"
SKIP_PYTHON_INSTALL="0"
SESSION_NAME="anime2026"
BOOTSTRAP_MODE="minimal"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-host)
      API_HOST="${2:-}"
      shift 2
      ;;
    --api-port)
      API_PORT="${2:-}"
      shift 2
      ;;
    --frontend-port)
      FRONTEND_PORT="${2:-}"
      shift 2
      ;;
    --venv-dir)
      VENV_DIR="${2:-}"
      shift 2
      ;;
    --session-name)
      SESSION_NAME="${2:-}"
      shift 2
      ;;
    --skip-python-install)
      SKIP_PYTHON_INSTALL="1"
      shift
      ;;
    --minimal-ui)
      BOOTSTRAP_MODE="minimal"
      shift
      ;;
    --full-bootstrap)
      BOOTSTRAP_MODE="full"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_START="$(date +%s)"

elapsed_text() {
  local now elapsed
  now="$(date +%s)"
  elapsed=$((now - SCRIPT_START))
  printf "+%02d:%02d:%02d" $((elapsed / 3600)) $(((elapsed % 3600) / 60)) $((elapsed % 60))
}

meta_log() {
  echo "[meta] $(elapsed_text) $*"
}

ensure_port_kill_tools() {
  if command -v lsof >/dev/null 2>&1 || command -v fuser >/dev/null 2>&1; then
    return 0
  fi

  meta_log "No lsof/fuser found; installing tools to free ports..."
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Neither lsof nor fuser found and apt-get is unavailable. Install lsof or psmisc and retry." >&2
    exit 1
  fi

  local runner
  if [[ "$(id -u)" == "0" ]]; then
    runner=""
  elif command -v sudo >/dev/null 2>&1; then
    runner="sudo"
  else
    echo "Neither lsof nor fuser found and sudo is unavailable. Install lsof/psmisc and retry." >&2
    exit 1
  fi

  ${runner:+$runner }apt-get update
  # lsof provides `lsof`; psmisc provides `fuser`
  ${runner:+$runner }apt-get install -y lsof psmisc
}

kill_listeners_on_port() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    # lsof exits 1 when no processes match; tolerate that under `set -e`.
    pids="$( (lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true) | tr '\n' ' ')"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "${port}" 2>/dev/null | tr '\n' ' ')"
  fi

  if [[ -z "${pids// }" ]]; then
    return 0
  fi

  meta_log "Port ${port} in use; killing PID(s): ${pids}"
  kill -TERM ${pids} 2>/dev/null || true
  sleep 0.5
  kill -KILL ${pids} 2>/dev/null || true
}

ensure_git_lfs() {
  if git lfs version >/dev/null 2>&1; then
    return 0
  fi

  meta_log "git-lfs not found; installing git-lfs via apt..."
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "git-lfs not found and apt-get is unavailable. Install git-lfs and retry." >&2
    exit 1
  fi

  local runner
  if [[ "$(id -u)" == "0" ]]; then
    runner=""
  elif command -v sudo >/dev/null 2>&1; then
    runner="sudo"
  else
    echo "git-lfs not found and sudo is unavailable. Install git-lfs and retry." >&2
    exit 1
  fi

  ${runner:+$runner }apt-get update
  ${runner:+$runner }apt-get install -y git-lfs

  if ! git lfs version >/dev/null 2>&1; then
    echo "git-lfs install completed but git-lfs still not available. Open a new shell and retry." >&2
    exit 1
  fi
}

ensure_bootstrap_python_deps() {
  meta_log "Ensuring minimal Python deps (FastAPI/uvicorn) in venv..."
  "${VENV_PYTHON}" -m pip install --upgrade pip "setuptools<82" wheel
  # Keep this list small; it must cover imports performed at API startup.
  # `services.character_storage` imports `requests`; timeline preview imports NumPy
  # and reaches `utils.image_utils`, which imports Pillow, during API startup.
  # FastAPI requires python-multipart for File/Form endpoints during app import.
  # NOTE: `/startup/ws` requires WebSocket support; install uvicorn with standard extras.
  "${VENV_PYTHON}" -m pip install fastapi "uvicorn[standard]" pydantic starlette requests python-multipart "numpy>=1.25.0" Pillow

  meta_log "Verifying WebSocket support in minimal venv..."
  "${VENV_PYTHON}" - <<'PY'
import uvicorn

ok = False
try:
    import websockets  # type: ignore
    ok = True
except Exception:
    pass

try:
    import wsproto  # type: ignore
    ok = True
except Exception:
    pass

if not ok:
    raise SystemExit(
        "Missing WebSocket backend. Install uvicorn[standard] or websockets/wsproto."
    )

print("ok")
PY
}

ensure_node_npm() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return 0
  fi

  meta_log "npm/node not found; installing Node.js (NodeSource) via apt..."
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "npm/node not found and apt-get is unavailable. Install Node.js/npm and retry." >&2
    exit 1
  fi

  local runner
  if [[ "$(id -u)" == "0" ]]; then
    runner=""
  elif command -v sudo >/dev/null 2>&1; then
    runner="sudo"
  else
    echo "npm/node not found and sudo is unavailable. Install Node.js/npm and retry." >&2
    echo "Suggested (Debian/Ubuntu):" >&2
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -" >&2
    echo "  sudo apt-get install -y nodejs" >&2
    exit 1
  fi

  ${runner:+$runner }apt-get update
  ${runner:+$runner }apt-get install -y ca-certificates curl gnupg
  if [[ -n "${runner}" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  fi
  ${runner:+$runner }apt-get install -y nodejs

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Node.js install completed but node/npm still not on PATH. Open a new shell and retry." >&2
    exit 1
  fi

  meta_log "Node ready: $(node --version), npm $(npm --version)"
}

ensure_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    return 0
  fi

  echo "tmux is required on Linux SSH hosts. Installing tmux..." >&2
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "apt-get is unavailable; install tmux and retry." >&2
    exit 1
  fi

  local runner
  if [[ "$(id -u)" == "0" ]]; then
    runner=""
  elif command -v sudo >/dev/null 2>&1; then
    runner="sudo"
  else
    echo "sudo is unavailable; install tmux and retry." >&2
    exit 1
  fi

  ${runner:+$runner }apt-get update
  ${runner:+$runner }apt-get install -y tmux

  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux install completed but tmux still not on PATH. Open a new shell and retry." >&2
    exit 1
  fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PATH="${REPO_ROOT}/${VENV_DIR}"
VENV_PYTHON="${VENV_PATH}/bin/python"
FRONTEND_DIR="${REPO_ROOT}/ui/frontend"
REQUIREMENTS_PY="${REPO_ROOT}/requirements.txt"
ON_DRIVE_PYTHON_DIR="$(cd "${REPO_ROOT}/.." && pwd)/python311"
ON_DRIVE_PYTHON_EXE="${ON_DRIVE_PYTHON_DIR}/bin/python3"
# Windows-style sibling layout when this script is run via Git Bash on the Seagate:
if [[ ! -x "${ON_DRIVE_PYTHON_EXE}" && -x "${ON_DRIVE_PYTHON_DIR}/python.exe" ]]; then
  ON_DRIVE_PYTHON_EXE="${ON_DRIVE_PYTHON_DIR}/python.exe"
fi

resolve_base_python() {
  if [[ -n "${ANIME2026_PYTHON:-}" && -x "${ANIME2026_PYTHON}" ]]; then
    printf '%s\n' "${ANIME2026_PYTHON}"
    return 0
  fi
  if [[ -x "${ON_DRIVE_PYTHON_EXE}" ]]; then
    printf '%s\n' "${ON_DRIVE_PYTHON_EXE}"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  return 1
}

repair_venv_pyvenv_cfg() {
  local base_python="$1"
  local cfg="${VENV_PATH}/pyvenv.cfg"
  [[ -f "${cfg}" ]] || return 1
  [[ -x "${VENV_PYTHON}" ]] || return 1
  local base_home
  base_home="$(cd "$(dirname "${base_python}")" && pwd)"
  local venv_resolved
  venv_resolved="$(cd "${VENV_PATH}" && pwd)"
  # Rewrite home/executable/command; keep include-system-site-packages / version lines.
  local tmp
  tmp="$(mktemp)"
  awk -v home="${base_home}" -v exe="${base_python}" -v cmd="${base_python} -m venv ${venv_resolved}" '
    BEGIN { h=0; e=0; c=0 }
    /^[[:space:]]*home[[:space:]]*=/ { print "home = " home; h=1; next }
    /^[[:space:]]*executable[[:space:]]*=/ { print "executable = " exe; e=1; next }
    /^[[:space:]]*command[[:space:]]*=/ { print "command = " cmd; c=1; next }
    { print }
    END {
      if (!h) print "home = " home
      if (!e) print "executable = " exe
      if (!c) print "command = " cmd
    }
  ' "${cfg}" > "${tmp}"
  mv "${tmp}" "${cfg}"
  if "${VENV_PYTHON}" -c "import sys; raise SystemExit(0 if sys.prefix else 1)" >/dev/null 2>&1; then
    meta_log "Venv probe OK after path repair"
    return 0
  fi
  return 1
}

ensure_venv() {
  local base_python="$1"
  if [[ -x "${VENV_PYTHON}" ]] && "${VENV_PYTHON}" -c "import sys; raise SystemExit(0 if sys.prefix else 1)" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -x "${VENV_PYTHON}" ]]; then
    meta_log "Venv not ready; attempting path repair…"
    if repair_venv_pyvenv_cfg "${base_python}"; then
      return 0
    fi
    meta_log "Venv irreparable; recreating at: ${VENV_PATH}"
    rm -rf "${VENV_PATH}"
  else
    meta_log "Creating venv at: ${VENV_PATH}"
  fi
  "${base_python}" -m venv "${VENV_PATH}"
  repair_venv_pyvenv_cfg "${base_python}" || true
  if [[ ! -x "${VENV_PYTHON}" ]]; then
    echo "Failed to create usable venv at: ${VENV_PATH}" >&2
    exit 1
  fi
  meta_log "Venv creation completed"
}

ensure_port_kill_tools
kill_listeners_on_port "${API_PORT}"
kill_listeners_on_port "${FRONTEND_PORT}"
kill_listeners_on_port "8188"

ensure_git_lfs
if [[ "${BOOTSTRAP_MODE}" == "full" ]]; then
  (
    cd "${REPO_ROOT}"
    git lfs install --local >/dev/null 2>&1 || true
    meta_log "Fetching Git LFS assets (git lfs pull)..."
    if ! git lfs pull; then
      echo >&2
      echo "ERROR: git lfs pull failed (auth required)." >&2
      echo "This repo's images are stored in Git LFS; without them the UI will show missing/black covers." >&2
      echo >&2
      echo "Fix options:" >&2
      echo "  - Configure git to authenticate to GitHub for this repo, then rerun:" >&2
      echo "      git lfs pull" >&2
      echo "  - If using HTTPS remotes, ensure you have credentials available (PAT / credential helper)." >&2
      echo "  - If using SSH remotes, ensure your SSH key is available and the remote is ssh-based." >&2
      echo >&2
      exit 2
    fi
  )
else
  meta_log "Skipping git lfs pull (minimal mode). Provide GitHub PAT in the UI and click Launch."
fi

if ! BASE_PYTHON="$(resolve_base_python)"; then
  echo "Python3 not found for portable bootstrap." >&2
  echo "Install CPython under ${ON_DRIVE_PYTHON_DIR} (sibling python311), set ANIME2026_PYTHON, or install host python3." >&2
  exit 1
fi
meta_log "Using base Python: ${BASE_PYTHON}"
ensure_venv "${BASE_PYTHON}"

if [[ "${BOOTSTRAP_MODE}" == "minimal" ]]; then
  ensure_bootstrap_python_deps
elif [[ "${SKIP_PYTHON_INSTALL}" != "1" ]]; then
  meta_log "Upgrading pip tooling in venv..."
  "${VENV_PYTHON}" -m pip install --upgrade pip "setuptools<82" wheel
  meta_log "Installing PyTorch (ANIME2026_TORCH_PROFILE) via services.pytorch_setup..."
  "${VENV_PYTHON}" -c "from services.pytorch_setup import ensure_pytorch_stack; ensure_pytorch_stack()"
  meta_log "Installing Python requirements into venv..."
  "${VENV_PYTHON}" -m pip install -r "${REQUIREMENTS_PY}"
  meta_log "Python requirements installation completed"
  meta_log "Installing kimodo (editable, MotionCorrection C extension; needs python dev headers matching venv)..."
  "${VENV_PYTHON}" -c "from services.kimodo_setup import pip_install_kimodo_editable; pip_install_kimodo_editable()"
  meta_log "Kimodo installation completed"
else
  meta_log "Skipping Python package install (--skip-python-install)"
fi

ensure_node_npm

if [[ ! -d "${FRONTEND_DIR}/node_modules" ]]; then
  meta_log "Installing frontend dependencies (npm install)..."
  (
    cd "${FRONTEND_DIR}"
    npm install
  )
  meta_log "Frontend dependency installation completed"
else
  meta_log "Frontend dependencies already present (node_modules exists)"
fi

ensure_tmux

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  meta_log "Existing tmux session '${SESSION_NAME}' found; replacing it"
  tmux kill-session -t "${SESSION_NAME}"
fi

# Long Comfy runs can be quiet for minutes; relax WS ping so proxies/clients are not dropped mid-job.
API_CMD="cd \"${REPO_ROOT}\" && \"${VENV_PYTHON}\" -m uvicorn ui.api.main:app --host ${API_HOST} --port ${API_PORT} --ws-ping-interval 20 --ws-ping-timeout 600"
WEB_CMD="cd \"${FRONTEND_DIR}\" && API_PROXY_DESTINATION=\"http://${API_HOST}:${API_PORT}\" npm run dev -- --port ${FRONTEND_PORT}"

meta_log "Starting backend and frontend in tmux session '${SESSION_NAME}'"
tmux new-session -d -s "${SESSION_NAME}" "${API_CMD}"
tmux new-window -t "${SESSION_NAME}:1" "${WEB_CMD}"
tmux select-window -t "${SESSION_NAME}:1"

meta_log "Services started in tmux"
echo
echo "Attach to session:"
echo "  tmux attach -t ${SESSION_NAME}"
echo
echo "Local SSH port-forward (run on your local machine):"
echo "  ssh -L ${FRONTEND_PORT}:127.0.0.1:${FRONTEND_PORT} <user>@<host>"
echo
echo "Then open locally:"
echo "  http://localhost:${FRONTEND_PORT}"
echo "  http://localhost:${FRONTEND_PORT}/api/docs   (API docs, proxied through Next.js)"
