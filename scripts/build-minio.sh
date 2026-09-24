#!/usr/bin/env sh
# Builds the MinIO server the test suites run against, from its archived source.
#
# MinIO withdrew its community distribution on September 11, 2026: dl.min.io answers
# 410 Gone and the minio/minio images left Docker Hub. The AGPL source is still public, so
# the last community release is built here with Go into .dev/bin/minio, where
# scripts/local-services.mjs looks first. Needs Go 1.24 or later and git.
set -eu
TAG="${MINIO_TAG:-RELEASE.2025-10-15T17-29-55Z}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --depth 1 --branch "$TAG" https://github.com/minio/minio.git "$WORK/minio"
mkdir -p "$ROOT/.dev/bin"
(cd "$WORK/minio" && CGO_ENABLED=0 go build -trimpath -o "$ROOT/.dev/bin/minio" .)
echo "Built MinIO $TAG into .dev/bin/minio"
