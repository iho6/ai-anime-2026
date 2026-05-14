#!/usr/bin/env bash
set -euo pipefail

IMAGE_REPO_URL="${IMAGE_REPO_URL:-anime2026/multi_angle_ai_service}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y-%m-%d-%H-%M-%S)}"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

export DOCKER_BUILDKIT=1

echo "Step 1: builder image..."
cp services/multi_angle_ai_service/deployment/builder.dockerignore .dockerignore
docker build \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  -t "${IMAGE_REPO_URL}:builder-${IMAGE_TAG}" \
  -f services/multi_angle_ai_service/deployment/Dockerfile.builder .

echo "Step 2: runtime image..."
cp services/multi_angle_ai_service/deployment/runtime.dockerignore .dockerignore
docker build \
  --build-arg BUILDER_IMAGE="${IMAGE_REPO_URL}:builder-${IMAGE_TAG}" \
  -t "${IMAGE_REPO_URL}:${IMAGE_TAG}" \
  -f services/multi_angle_ai_service/deployment/Dockerfile.runtime .
rm -f .dockerignore

echo "Built ${IMAGE_REPO_URL}:${IMAGE_TAG}"
