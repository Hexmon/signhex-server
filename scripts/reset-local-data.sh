#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/reset-local-data.sh [--yes]

What it does:
  - Stops the local Docker Compose stack
  - Deletes the PostgreSQL Docker volume
  - Deletes the MinIO Docker volume
  - Removes orphaned containers from this compose project

Notes:
  - This is destructive.
  - It only resets the Docker-managed local PostgreSQL and MinIO data for signhex-server.
  - It does not recreate the database or reseed data.

Examples:
  npm run reset:data
  npm run reset:data -- --yes
EOF
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command not found: ${command_name}" >&2
    exit 1
  fi
}

confirm_reset() {
  local answer
  printf "This will permanently delete local PostgreSQL and MinIO data. Continue? [y/N] "
  read -r answer
  case "${answer}" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Aborted."
      exit 0
      ;;
  esac
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

require_command docker

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose is not available on this machine." >&2
  exit 1
fi

if [[ "${1:-}" != "--yes" ]]; then
  confirm_reset
fi

cd "${PROJECT_DIR}"

echo "Stopping containers and deleting PostgreSQL/MinIO volumes..."
docker compose down -v --remove-orphans

cat <<'EOF'
Local PostgreSQL and MinIO data have been deleted.

To start fresh again:
  docker compose up -d postgres minio
  npm run db:push
  npm run seed
EOF
