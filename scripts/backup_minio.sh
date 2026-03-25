#!/bin/bash

# Hexmon Signage - MinIO Backup Script
# Usage: ./backup_minio.sh [backup_dir]

set -e

BACKUP_DIR="${1:-.}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/hexmon_minio_$TIMESTAMP.tar.gz"

# MinIO configuration from environment
MINIO_ENDPOINT="${MINIO_ENDPOINT:-localhost}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-}"
MINIO_USE_SSL="${MINIO_USE_SSL:-false}"
BACKUP_SKIP_ARCHIVES="${BACKUP_SKIP_ARCHIVES:-false}"

if [ -z "$MINIO_ACCESS_KEY" ] || [ -z "$MINIO_SECRET_KEY" ]; then
    echo "Error: MINIO_ACCESS_KEY and MINIO_SECRET_KEY environment variables are required"
    exit 1
fi

echo "Starting MinIO backup..."
echo "Backup file: $BACKUP_FILE"
echo "MinIO endpoint: $MINIO_ENDPOINT:$MINIO_PORT"

# Set protocol
if [ "$MINIO_USE_SSL" = "true" ]; then
    PROTOCOL="https"
else
    PROTOCOL="http"
fi

# Create temporary directory for backup
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# List of buckets to backup
BUCKETS=(
    "media-source"
    "media-ready"
    "media-thumbnails"
    "device-screenshots"
    "logs-audit"
    "logs-system"
    "logs-auth"
    "logs-heartbeats"
    "logs-pop"
)

if [ "$BACKUP_SKIP_ARCHIVES" != "true" ]; then
    BUCKETS+=("archives")
fi

# Configure mc (MinIO client)
mc alias set hexmon "$PROTOCOL://$MINIO_ENDPOINT:$MINIO_PORT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" --api S3v4

# Backup each bucket
for bucket in "${BUCKETS[@]}"; do
    echo "Backing up bucket: $bucket"
    mc mirror "hexmon/$bucket" "$TEMP_DIR/$bucket" --quiet || true
done

# Create tar archive
echo "Creating archive..."
tar -czf "$BACKUP_FILE" -C "$TEMP_DIR" . 2>/dev/null

echo "Backup completed successfully: $BACKUP_FILE"
echo "Backup size: $(du -h "$BACKUP_FILE" | cut -f1)"
