#!/usr/bin/env bash
#
# Install required ComfyUI custom nodes into comfyui/custom_nodes/.
# Delegates to services.logic.install_required_custom_nodes (same path as app startup).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

exec python -c "from services.logic import install_required_custom_nodes; install_required_custom_nodes()"
