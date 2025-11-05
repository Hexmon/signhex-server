#!/bin/bash

# Hexmon Signage - PostgreSQL Backup Script
# Usage: ./backup_postgres.sh [backup_dir]

set -e

BACKUP_DIR="${1:-.}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/hexmon_postgres_$TIMESTAMP.sql.gz"

# Get database URL from environment or use default
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/hexmon}"

echo "Starting PostgreSQL backup..."
echo "Backup file: $BACKUP_FILE"

# Extract connection details from DATABASE_URL
# Format: postgresql://user:password@host:port/database
if [[ $DB_URL =~ postgresql://([^:]+):([^@]+)@([^:]+):([^/]+)/(.+) ]]; then
    DB_USER="${BASH_REMATCH[1]}"
    DB_PASSWORD="${BASH_REMATCH[2]}"
    DB_HOST="${BASH_REMATCH[3]}"
    DB_PORT="${BASH_REMATCH[4]}"
    DB_NAME="${BASH_REMATCH[5]}"
else
    echo "Error: Invalid DATABASE_URL format"
    exit 1
fi

# Create backup
PGPASSWORD="$DB_PASSWORD" pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --verbose \
    | gzip > "$BACKUP_FILE"

echo "Backup completed successfully: $BACKUP_FILE"
echo "Backup size: $(du -h "$BACKUP_FILE" | cut -f1)"

