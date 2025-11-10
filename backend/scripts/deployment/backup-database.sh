#!/bin/bash

# Database Backup Script
# Automated backup script for TAPS database

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
S3_BUCKET=${BACKUP_S3_BUCKET:-}
S3_REGION=${AWS_REGION:-us-east-1}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
LOG_FILE=${LOG_FILE:-/var/log/taps/backups.log}

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

    # Check if pg_dump is available
    if ! command -v pg_dump &> /dev/null; then
        error "pg_dump is not installed"
        exit 1
    fi

    # Check if backup directory exists
    if [ ! -d "$BACKUP_DIR" ]; then
        log "Creating backup directory: $BACKUP_DIR"
        mkdir -p "$BACKUP_DIR"
    fi

    # Check if S3 is configured
    if [ -n "$S3_BUCKET" ]; then
        if ! command -v aws &> /dev/null; then
            warn "AWS CLI is not installed - S3 upload will be skipped"
            S3_BUCKET=""
        fi
    fi

    log "Prerequisites check passed"
}

# Create database backup
create_backup() {
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_DIR/taps_backup_${ENV}_${timestamp}.sql"

    log "Creating database backup..."
    log "Backup file: $backup_file"

    # Run pg_dump with custom format for better compression and partial restore support
    if pg_dump "$DATABASE_URL" \
        --format=custom \
        --compress=9 \
        --verbose \
        --file="$backup_file.dump" \
        2>> "$LOG_FILE"; then

        log "Database backup created successfully"
        echo "$backup_file.dump"
    else
        error "Failed to create database backup"
        exit 1
    fi
}

# Create SQL dump (human-readable)
create_sql_dump() {
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local sql_file="$BACKUP_DIR/taps_dump_${ENV}_${timestamp}.sql"

    log "Creating SQL dump..."

    if pg_dump "$DATABASE_URL" > "$sql_file"; then
        # Compress SQL file
        gzip "$sql_file"
        log "SQL dump created and compressed: ${sql_file}.gz"
        echo "${sql_file}.gz"
    else
        warn "Failed to create SQL dump"
        echo ""
    fi
}

# Upload to S3
upload_to_s3() {
    local file=$1

    if [ -z "$S3_BUCKET" ]; then
        log "S3 bucket not configured - skipping upload"
        return 0
    fi

    log "Uploading backup to S3: s3://$S3_BUCKET/$(basename $file)"

    if aws s3 cp "$file" \
        "s3://$S3_BUCKET/$(basename $file)" \
        --region "$S3_REGION" \
        --storage-class STANDARD_IA \
        2>> "$LOG_FILE"; then

        log "Backup uploaded to S3 successfully"
        return 0
    else
        error "Failed to upload backup to S3"
        return 1
    fi
}

# Clean old backups
clean_old_backups() {
    log "Cleaning old backups (retention: $RETENTION_DAYS days)..."

    # Clean local backups
    local deleted_count=0

    while IFS= read -r file; do
        rm -f "$file"
        deleted_count=$((deleted_count + 1))
        log "Deleted old backup: $(basename $file)"
    done < <(find "$BACKUP_DIR" -type f -name "taps_*.sql*" -o -name "taps_*.dump" -mtime +$RETENTION_DAYS)

    log "Deleted $deleted_count old local backup(s)"

    # Clean S3 backups
    if [ -n "$S3_BUCKET" ]; then
        log "Cleaning old S3 backups..."

        aws s3 ls "s3://$S3_BUCKET/" --recursive | \
        while read -r line; do
            local file_date=$(echo "$line" | awk '{print $1}')
            local file_name=$(echo "$line" | awk '{print $4}')

            # Calculate age of file
            local file_epoch=$(date -d "$file_date" +%s)
            local current_epoch=$(date +%s)
            local age_days=$(( ($current_epoch - $file_epoch) / 86400 ))

            if [ $age_days -gt $RETENTION_DAYS ]; then
                log "Deleting old S3 backup: $file_name (age: $age_days days)"
                aws s3 rm "s3://$S3_BUCKET/$file_name" --region "$S3_REGION"
            fi
        done
    fi
}

# Verify backup
verify_backup() {
    local backup_file=$1

    log "Verifying backup integrity..."

    # Check if file exists and is not empty
    if [ ! -f "$backup_file" ]; then
        error "Backup file not found: $backup_file"
        return 1
    fi

    local file_size=$(stat -f%z "$backup_file" 2>/dev/null || stat -c%s "$backup_file" 2>/dev/null)

    if [ "$file_size" -eq 0 ]; then
        error "Backup file is empty"
        return 1
    fi

    log "Backup file size: $(numfmt --to=iec-i --suffix=B $file_size 2>/dev/null || echo $file_size bytes)"

    # For custom format dumps, use pg_restore to verify
    if [[ "$backup_file" == *.dump ]]; then
        if pg_restore --list "$backup_file" > /dev/null 2>&1; then
            log "Backup verification passed"
            return 0
        else
            error "Backup verification failed - file may be corrupted"
            return 1
        fi
    fi

    log "Backup verification passed (basic check)"
    return 0
}

# Get backup statistics
get_backup_stats() {
    log "Backup Statistics:"
    log "  Local backups: $(find "$BACKUP_DIR" -type f \( -name "*.sql*" -o -name "*.dump" \) | wc -l)"
    log "  Disk usage: $(du -sh "$BACKUP_DIR" | cut -f1)"

    if [ -n "$S3_BUCKET" ]; then
        log "  S3 backups: $(aws s3 ls "s3://$S3_BUCKET/" --recursive | wc -l)"
    fi
}

# Send notification
send_notification() {
    local status=$1
    local message=$2

    log "Notification: [$status] $message"

    # Send to Slack if configured
    if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
        curl -X POST "$SLACK_WEBHOOK_URL" \
            -H 'Content-Type: application/json' \
            -d "{\"text\": \"[TAPS Backup] $status: $message\"}" \
            2>&1 | tee -a "$LOG_FILE"
    fi

    # Send email if configured
    if [ -n "${ALERT_EMAIL:-}" ]; then
        echo "$message" | mail -s "[TAPS] Backup $status" "$ALERT_EMAIL"
    fi
}

# Main execution
main() {
    log "========================================="
    log "Starting database backup"
    log "Environment: $ENV"
    log "========================================="

    # Check prerequisites
    check_prerequisites

    # Create backup
    local backup_file=$(create_backup)

    if [ -z "$backup_file" ]; then
        error "Backup creation failed"
        send_notification "FAILURE" "Database backup failed"
        exit 1
    fi

    # Verify backup
    if ! verify_backup "$backup_file"; then
        error "Backup verification failed"
        send_notification "FAILURE" "Database backup verification failed"
        exit 1
    fi

    # Upload to S3
    if [ -n "$S3_BUCKET" ]; then
        upload_to_s3 "$backup_file"
    fi

    # Create SQL dump (optional, for human readability)
    if [ "${CREATE_SQL_DUMP:-true}" == "true" ]; then
        create_sql_dump
    fi

    # Clean old backups
    clean_old_backups

    # Show statistics
    get_backup_stats

    log "========================================="
    log "Backup completed successfully"
    log "Backup file: $backup_file"
    log "========================================="

    send_notification "SUCCESS" "Database backup completed successfully"
    exit 0
}

# Handle interrupts
trap 'error "Script interrupted"; exit 130' INT TERM

# Run main function
main
