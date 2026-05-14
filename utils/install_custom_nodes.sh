#!/usr/bin/env bash
#
# Install ComfyUI custom nodes into comfyui/custom_nodes.
#
# Current repo workflows (img-edit, edit-angle) do not require custom nodes yet.
# Placeholder node entries are intentionally commented out below.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CUSTOM_NODES_DIR="${1:-${REPO_ROOT}/comfyui/custom_nodes}"

log() {
  echo "[custom-nodes] $*"
}

clone_custom_node() {
  local repo_url="$1"
  local node_dir_name="$2"
  local ref="${3:-}"
  local dest="${CUSTOM_NODES_DIR}/${node_dir_name}"

  if [[ -d "${dest}" ]]; then
    log "Skip existing node: ${node_dir_name}"
  else
    log "Cloning ${repo_url} -> ${dest}"
    git clone --depth 1 "${repo_url}" "${dest}"
  fi

  if [[ -n "${ref}" ]]; then
    log "Checking out ${node_dir_name} at ref ${ref}"
    git -C "${dest}" fetch --depth 1 origin "${ref}"
    git -C "${dest}" checkout --detach FETCH_HEAD
  fi

  rm -rf "${dest}/.git"
  rm -f "${dest}/.gitmodules"
  log "Detached git metadata for ${node_dir_name}"
}

mkdir -p "${CUSTOM_NODES_DIR}"
log "Custom node target: ${CUSTOM_NODES_DIR}"

# Placeholder list (commented out intentionally until workflows need custom nodes):
# clone_custom_node "https://github.com/example-org/ComfyUI-Manager.git" "ComfyUI-Manager"
# clone_custom_node "https://github.com/example-org/ComfyUI-SomeNode.git" "ComfyUI-SomeNode" "v1.2.3"

log "No active custom nodes configured; skipping custom-node installation."
