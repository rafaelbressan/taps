#!/bin/bash

# Database Migration Deployment Script
# Safely deploys database migrations to production

set -e  # Exit on error
set -u  # Exit on undefined variable

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
ENV=${ENV:-production}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/taps}
LOG_FILE=${LOG_FILE:-/var/log/taps/migrations.log}

# Functions
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1" | tee -a "$LOG_FILE"
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."

    # Check if DATABASE_URL is set
    if [ -z "${DATABASE_URL:-}" ]; then
        error "DATABASE_URL environment variable is not set"
        exit 1
    fi

    # Check if node is installed
    if ! command -v node &> /dev/null; then
        error "Node.js is not installed"
        exit 1
    fi

    # Check if npx is available
    if ! command -v npx &> /dev/null; then
        error "npx is not available"
        exit 1
    fi

    log "Prerequisites check passed"
}

# Create backup before migration
create_backup() {
    log "Creating database backup before migration..."

    # Ensure backup directory exists
    mkdir -p "$BACKUP_DIR"

    # Extract database connection details
    # Format: postgresql://user:password@host:port/database
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_DIR/pre_migration_${timestamp}.sql"

    # Run pg_dump
    log "Running pg_dump to $backup_file..."

    if pg_dump "$DATABASE_URL" > "$backup_file"; then
        log "Backup created successfully: $backup_file"

        # Compress backup
        gzip "$backup_file"
        log "Backup compressed: ${backup_file}.gz"

        # Store backup file path for potential rollback
        echo "$backup_file.gz" > /tmp/last_migration_backup.txt
    else
        error "Failed to create database backup"
        exit 1
    fi
}

# Check migration status
check_migration_status() {
    log "Checking current migration status..."

    npx prisma migrate status | tee -a "$LOG_FILE"
}

# Deploy migrations
deploy_migrations() {
    log "Deploying database migrations..."

    # Deploy migrations
    if npx prisma migrate deploy; then
        log "Migrations deployed successfully"
        return 0
    else
        error "Migration deployment failed"
        return 1
    fi
}

# Verify migrations
verify_migrations() {
    log "Verifying migrations..."

    # Check if all migrations are applied
    local status_output=$(npx prisma migrate status)

    if echo "$status_output" | grep -q "Database schema is up to date"; then
        log "Migration verification passed"
        return 0
    else
        warn "Migration verification inconclusive"
        echo "$status_output" | tee -a "$LOG_FILE"
        return 1
    fi
}

# Rollback migrations
rollback_migrations() {
    error "Migration failed - initiating rollback..."

    local backup_file=$(cat /tmp/last_migration_backup.txt 2>/dev/null || echo "")

    if [ -z "$backup_file" ] || [ ! -f "$backup_file" ]; then
        error "No backup file found for rollback"
        error "Manual intervention required"
        exit 1
    fi

    log "Restoring database from backup: $backup_file"

    # Extract database name from DATABASE_URL
    local db_name=$(echo "$DATABASE_URL" | sed -E 's/.*\/([^?]+).*/\1/')

    # Restore from backup
    gunzip -c "$backup_file" | psql "$DATABASE_URL" -d "$db_name"

    if [ $? -eq 0 ]; then
        log "Database restored successfully from backup"
    else
        error "Failed to restore database from backup"
        error "CRITICAL: Database may be in inconsistent state"
        exit 1
    fi
}

# Send notification
send_notification() {
    local status=$1
    local message=$2

    # TODO: Implement notification (Slack, email, etc.)
    log "Notification: [$status] $message"

    # Example: Send to Slack
    if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
        curl -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-Type: application/json' \
            -d "{\"text\": \"[TAPS Migration] $status: $message\"}" \
            2>&1 | tee -a "$LOG_FILE"
    fi
}

# Main execution
main() {
    log "========================================="
    log "Starting database migration deployment"
    log "Environment: $ENV"
    log "========================================="

    # Check prerequisites
    check_prerequisites

    # Create backup
    if [ "${SKIP_BACKUP:-false}" != "true" ]; then
        create_backup
    else
        warn "Skipping backup (SKIP_BACKUP=true)"
    fi

    # Check current status
    check_migration_status

    # Deploy migrations
    if deploy_migrations; then
        # Verify migrations
        if verify_migrations; then
            log "========================================="
            log "Migration deployment completed successfully"
            log "========================================="

            send_notification "SUCCESS" "Database migrations deployed successfully"
            exit 0
        else
            warn "Migration verification failed"
            send_notification "WARNING" "Migrations deployed but verification failed"
            exit 1
        fi
    else
        # Migration failed - rollback
        rollback_migrations
        send_notification "FAILURE" "Migration failed and rolled back"
        exit 1
    fi
}

# Handle interrupts
trap 'error "Script interrupted"; exit 130' INT TERM

# Run main function
main
