# TAPS Deployment Runbook

This document provides step-by-step instructions for deploying TAPS to production and staging environments.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Pre-Deployment Checklist](#pre-deployment-checklist)
3. [Deployment Process](#deployment-process)
4. [Post-Deployment Verification](#post-deployment-verification)
5. [Rollback Procedures](#rollback-procedures)
6. [Monitoring and Alerts](#monitoring-and-alerts)
7. [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Access
- AWS Console access
- GitHub repository access
- Database administrator credentials
- Sentry project access
- Slack notification webhook (optional)

### Required Tools
- AWS CLI configured
- Docker installed
- PostgreSQL client tools
- kubectl (for Kubernetes deployments)
- Node.js 18+

### Environment Variables
Ensure all required environment variables are configured in your secrets manager:

```bash
# Required
DATABASE_URL
JWT_SECRET
WALLET_ENCRYPTION_KEY
WALLET_ENCRYPTION_IV

# Optional but recommended
SENTRY_DSN
SLACK_WEBHOOK_URL
ALERT_EMAIL
```

## Pre-Deployment Checklist

### 1. Code Review
- [ ] All PR reviews approved
- [ ] CI/CD pipeline passing
- [ ] Test coverage meets requirements (>70% global, >80% rewards)
- [ ] Security scan passed (no high/critical vulnerabilities)
- [ ] Performance tests passed

### 2. Database
- [ ] Backup created (automatic in migration script)
- [ ] Migration files reviewed
- [ ] Migration tested in staging
- [ ] Rollback plan ready

### 3. Configuration
- [ ] Environment variables verified
- [ ] Secrets updated in secrets manager
- [ ] Feature flags configured
- [ ] Rate limits reviewed

### 4. Monitoring
- [ ] Sentry configured and tested
- [ ] Prometheus metrics endpoint accessible
- [ ] Alerts configured
- [ ] Log aggregation working

### 5. Communication
- [ ] Stakeholders notified of deployment window
- [ ] Maintenance window scheduled (if needed)
- [ ] On-call engineer identified

## Deployment Process

### Automated Deployment (Recommended)

#### Staging Deployment
```bash
# Push to staging branch
git checkout staging
git merge main
git push origin staging

# GitHub Actions will automatically:
# 1. Run tests
# 2. Build Docker image
# 3. Deploy to staging ECS
# 4. Run migrations
# 5. Verify health checks
```

#### Production Deployment
```bash
# Push to main branch
git checkout main
git merge staging  # Ensure staging is tested
git push origin main

# GitHub Actions will automatically:
# 1. Create backup
# 2. Run tests
# 3. Build Docker image
# 4. Deploy to production ECS (blue-green)
# 5. Run migrations
# 6. Run smoke tests
# 7. Tag release
```

### Manual Deployment

#### Step 1: Build Docker Image
```bash
cd backend

# Build image
docker build -t taps-backend:$(git rev-parse --short HEAD) -f Dockerfile.production .

# Tag for registry
docker tag taps-backend:$(git rev-parse --short HEAD) ${ECR_REGISTRY}/taps-backend:production-$(git rev-parse --short HEAD)

# Push to registry
docker push ${ECR_REGISTRY}/taps-backend:production-$(git rev-parse --short HEAD)
```

#### Step 2: Run Database Migrations
```bash
# SSH into migration task or use ECS task
aws ecs run-task \
  --cluster taps-production \
  --task-definition taps-migration \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_ID}],securityGroups=[${SG_ID}]}"

# OR run migration script directly
./scripts/deployment/migrate-database.sh
```

#### Step 3: Deploy Application
```bash
# Update ECS service
aws ecs update-service \
  --cluster taps-production \
  --service taps-backend \
  --force-new-deployment \
  --task-definition taps-backend:latest

# Wait for deployment
aws ecs wait services-stable \
  --cluster taps-production \
  --services taps-backend
```

#### Step 4: Verify Deployment
```bash
# Check health endpoint
curl https://taps.example.com/health

# Check metrics endpoint
curl https://taps.example.com/metrics

# Verify logs
aws logs tail /ecs/taps-backend --follow
```

## Post-Deployment Verification

### 1. Health Checks
```bash
# Check all health endpoints
curl https://taps.example.com/health
curl https://taps.example.com/health/live
curl https://taps.example.com/health/ready

# Expected response:
{
  "status": "ok",
  "timestamp": "2025-01-10T12:00:00.000Z",
  "uptime": 123,
  "version": "2.0.0",
  "checks": {
    "database": {"status": "ok", "responseTime": 50},
    "tezosRpc": {"status": "ok", "responseTime": 200}
  }
}
```

### 2. Smoke Tests
```bash
# Test authentication
curl -X POST https://taps.example.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}'

# Test settings endpoint
curl https://taps.example.com/api/v1/settings \
  -H "Authorization: Bearer ${TOKEN}"

# Test metrics
curl https://taps.example.com/metrics | grep http_requests_total
```

### 3. Database Verification
```bash
# Check migrations applied
npm run prisma:migrate:status

# Verify data integrity
psql $DATABASE_URL -c "SELECT COUNT(*) FROM settings;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM payment WHERE result = 'paid';"
```

### 4. Monitoring Verification
```bash
# Check Sentry for errors
# Visit: https://sentry.io/organizations/your-org/issues/

# Check Prometheus metrics
# Visit: https://prometheus.example.com/targets

# Check application logs
aws logs tail /ecs/taps-backend --since 10m
```

### 5. Performance Verification
```bash
# Run load test (optional)
k6 run test/load/k6-load-test.js

# Check response times
curl -w "@curl-format.txt" -o /dev/null -s https://taps.example.com/health
```

## Rollback Procedures

### Automatic Rollback

GitHub Actions includes automatic rollback on failure:
- Monitors deployment health for 5 minutes
- Automatically reverts to previous task definition on failure
- Sends Slack notification

### Manual Rollback

#### Step 1: Identify Previous Version
```bash
# List recent deployments
aws ecs describe-services \
  --cluster taps-production \
  --services taps-backend \
  --query 'services[0].deployments'

# OR check git tags
git tag -l | tail -n 5
```

#### Step 2: Revert Application
```bash
# Update to previous task definition
aws ecs update-service \
  --cluster taps-production \
  --service taps-backend \
  --task-definition taps-backend:PREVIOUS_REVISION \
  --force-new-deployment
```

#### Step 3: Rollback Database (if needed)
```bash
# Restore from backup
./scripts/deployment/restore-database.sh /var/backups/taps/backup_file.dump

# OR manually restore
gunzip -c backup_file.dump | pg_restore -d ${DATABASE_URL}
```

#### Step 4: Verify Rollback
```bash
# Check health
curl https://taps.example.com/health

# Check logs for errors
aws logs tail /ecs/taps-backend --follow

# Verify application version
curl https://taps.example.com/health | jq .version
```

## Monitoring and Alerts

### Key Metrics to Monitor

#### Application Metrics
- **Response Time**: p95 < 1s, p99 < 1.5s
- **Error Rate**: < 1%
- **Request Rate**: Monitor for unusual spikes
- **Active Connections**: Database and Redis

#### Business Metrics
- **Reward Distributions**: Success rate > 99%
- **Active Delegators**: Monitor for drops
- **Baker Balance**: Alert on low balance
- **Cycle Processing Time**: < 5 minutes

#### System Metrics
- **CPU Usage**: < 80%
- **Memory Usage**: < 85%
- **Disk Usage**: < 80%
- **Network I/O**: Monitor for saturation

### Alert Thresholds

```yaml
Critical Alerts:
  - Database down
  - Application health check failing
  - Error rate > 5%
  - Reward distribution failures > 3 consecutive

Warning Alerts:
  - Error rate > 1%
  - Response time p95 > 2s
  - CPU usage > 80%
  - Memory usage > 85%
  - Disk usage > 80%
```

### Alert Channels
- **Slack**: #taps-alerts
- **Email**: ops@example.com
- **PagerDuty**: For critical alerts
- **Sentry**: For error tracking

## Troubleshooting

### Common Issues

#### 1. Health Check Failing

**Symptoms:**
- `/health` endpoint returns 503
- ECS tasks keep restarting

**Diagnosis:**
```bash
# Check container logs
aws logs tail /ecs/taps-backend --follow

# Check database connectivity
psql $DATABASE_URL -c "SELECT 1"

# Check Tezos RPC
curl $TEZOS_RPC_URL/chains/main/blocks/head
```

**Resolution:**
- Verify environment variables
- Check database migrations
- Verify network security groups
- Restart service if needed

#### 2. Database Migration Fails

**Symptoms:**
- Migration script exits with error
- Database in inconsistent state

**Diagnosis:**
```bash
# Check migration status
npx prisma migrate status

# View migration logs
cat /var/log/taps/migrations.log
```

**Resolution:**
- Restore from pre-migration backup
- Fix migration file
- Re-run migration

#### 3. High Memory Usage

**Symptoms:**
- OOM kills
- Slow response times
- ECS tasks restarting

**Diagnosis:**
```bash
# Check memory metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name MemoryUtilization \
  --dimensions Name=ServiceName,Value=taps-backend

# Check for memory leaks in logs
```

**Resolution:**
- Increase task memory
- Check for memory leaks
- Optimize database queries
- Review connection pooling

#### 4. Tezos RPC Errors

**Symptoms:**
- Cycle check failures
- Balance retrieval errors
- High RPC error rate

**Diagnosis:**
```bash
# Check RPC connectivity
curl $TEZOS_RPC_URL/chains/main/blocks/head

# Check fallback RPC
curl $TEZOS_FALLBACK_RPC_URL/chains/main/blocks/head

# Review Prometheus metrics
curl https://taps.example.com/metrics | grep tezos_rpc_errors_total
```

**Resolution:**
- Switch to fallback RPC
- Increase retry attempts
- Add rate limiting
- Contact RPC provider

### Emergency Contacts

- **On-Call Engineer**: [Phone/Email]
- **DevOps Team**: [Slack Channel]
- **Database Administrator**: [Contact]
- **AWS Support**: [Support Plan]

### Useful Commands

```bash
# View recent deployments
aws ecs describe-services --cluster taps-production --services taps-backend

# View running tasks
aws ecs list-tasks --cluster taps-production --service-name taps-backend

# View task logs
aws logs tail /ecs/taps-backend --follow --since 10m

# Force new deployment
aws ecs update-service --cluster taps-production --service taps-backend --force-new-deployment

# Scale service
aws ecs update-service --cluster taps-production --service taps-backend --desired-count 3

# Check database connections
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity;"

# Create manual backup
./scripts/deployment/backup-database.sh

# View Sentry errors
open https://sentry.io/organizations/your-org/projects/taps/
```

## Best Practices

1. **Always deploy to staging first**
2. **Run full test suite before deployment**
3. **Monitor logs during and after deployment**
4. **Keep deployment window during low-traffic hours**
5. **Have rollback plan ready**
6. **Communicate with stakeholders**
7. **Document any manual steps taken**
8. **Review post-mortem for failed deployments**

## Additional Resources

- [Architecture Documentation](../architecture/ARCHITECTURE.md)
- [API Documentation](https://taps.example.com/api/docs)
- [Monitoring Dashboard](https://grafana.example.com)
- [Incident Response Procedures](./INCIDENT_RESPONSE.md)
- [Backup and Recovery](./BACKUP_RECOVERY.md)
