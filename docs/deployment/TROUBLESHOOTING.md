# TAPS Troubleshooting Guide

Comprehensive guide for diagnosing and resolving common issues in TAPS.

## Table of Contents

1. [Application Issues](#application-issues)
2. [Database Issues](#database-issues)
3. [Authentication Issues](#authentication-issues)
4. [Tezos Integration Issues](#tezos-integration-issues)
5. [Performance Issues](#performance-issues)
6. [Deployment Issues](#deployment-issues)
7. [Monitoring and Logging](#monitoring-and-logging)

## Application Issues

### Application Won't Start

**Symptoms:**
- Container exits immediately
- Health checks fail
- Error in startup logs

**Common Causes:**
1. Missing environment variables
2. Database connection failure
3. Port already in use
4. Syntax errors in code

**Diagnosis:**
```bash
# Check container logs
docker logs <container_id>

# Check environment variables
docker exec <container_id> env | sort

# Test database connection
docker exec <container_id> psql $DATABASE_URL -c "SELECT 1"

# Check port usage
netstat -tulpn | grep 3000
```

**Solutions:**
- Verify all required env vars are set
- Check DATABASE_URL format and credentials
- Ensure no conflicts on ports 3000/9090
- Review application logs for specific errors

### Application Crashes Randomly

**Symptoms:**
- Container restarts frequently
- OOM (Out of Memory) errors
- Seg faults in logs

**Diagnosis:**
```bash
# Check memory usage
docker stats <container_id>

# Review crash logs
docker logs --tail 100 <container_id>

# Check system resources
top
free -h
df -h
```

**Solutions:**
- Increase container memory limits
- Check for memory leaks in code
- Review database connection pooling
- Optimize queries and caching

### High CPU Usage

**Symptoms:**
- Slow response times
- CPU at 100%
- Request timeouts

**Diagnosis:**
```bash
# Profile CPU usage
node --prof dist/main.js

# Check for infinite loops
cat /var/log/taps/app.log | grep "Processing"

# Review Prometheus metrics
curl localhost:9090/metrics | grep cpu
```

**Solutions:**
- Profile and optimize hot code paths
- Add caching for expensive operations
- Optimize database queries
- Implement rate limiting

## Database Issues

### Connection Pool Exhausted

**Symptoms:**
- "connection pool exhausted" errors
- Timeouts on database operations
- Slow query performance

**Diagnosis:**
```bash
# Check active connections
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"

# Check connection pool status
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE state = 'active';"

# Review Prisma logs
grep "connection" /var/log/taps/app.log
```

**Solutions:**
```typescript
// Increase connection pool size
DATABASE_URL="postgresql://user:pass@host:5432/db?connection_limit=20"

// Or in Prisma schema
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  pool_timeout = 30
}
```

### Slow Queries

**Symptoms:**
- High database response times
- Request timeouts
- Poor performance

**Diagnosis:**
```bash
# Enable slow query logging
psql $DATABASE_URL -c "ALTER SYSTEM SET log_min_duration_statement = 1000;"
psql $DATABASE_URL -c "SELECT pg_reload_conf();"

# Check slow queries
psql $DATABASE_URL -c "SELECT query, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# Analyze specific query
psql $DATABASE_URL -c "EXPLAIN ANALYZE SELECT * FROM payment WHERE bakerId = 'tz1...';"
```

**Solutions:**
- Add indexes on frequently queried columns
- Optimize N+1 queries
- Use pagination for large result sets
- Implement query caching

### Migration Failures

**Symptoms:**
- Migration script exits with error
- Database in inconsistent state
- Application fails to start

**Diagnosis:**
```bash
# Check migration status
npx prisma migrate status

# View migration history
psql $DATABASE_URL -c "SELECT * FROM _prisma_migrations ORDER BY finished_at DESC;"

# Check for schema drift
npx prisma migrate diff
```

**Solutions:**
```bash
# Rollback to previous state
./scripts/deployment/restore-database.sh <backup_file>

# Force reset (dev only)
npx prisma migrate reset

# Apply migrations manually
npx prisma migrate resolve --applied <migration_name>
```

## Authentication Issues

### JWT Token Invalid

**Symptoms:**
- 401 Unauthorized errors
- "Invalid token" messages
- Users logged out unexpectedly

**Diagnosis:**
```bash
# Decode JWT token
echo $TOKEN | cut -d. -f2 | base64 -d | jq

# Check token expiration
date -d @$(echo $TOKEN | cut -d. -f2 | base64 -d | jq -r .exp)

# Verify JWT_SECRET matches
echo $JWT_SECRET
```

**Solutions:**
- Verify JWT_SECRET is consistent across deployments
- Check token expiration time
- Ensure system clocks are synchronized
- Regenerate tokens if secret changed

### Login Fails

**Symptoms:**
- Login endpoint returns 401
- Correct credentials don't work
- Password verification fails

**Diagnosis:**
```bash
# Check user exists
psql $DATABASE_URL -c "SELECT bakerId, userName FROM settings WHERE userName = 'test';"

# Verify password hash
psql $DATABASE_URL -c "SELECT passHash FROM settings WHERE userName = 'test';"

# Test bcrypt comparison
node -e "const bcrypt = require('bcrypt'); bcrypt.compare('password', 'hash', (err, res) => console.log(res));"
```

**Solutions:**
- Verify password is being hashed correctly
- Check bcrypt salt rounds (should be 12)
- Reset password using migration script
- Review authentication logic

## Tezos Integration Issues

### RPC Connection Failures

**Symptoms:**
- "Failed to connect to Tezos RPC" errors
- Cycle check failures
- Balance retrieval errors

**Diagnosis:**
```bash
# Test primary RPC
curl $TEZOS_RPC_URL/chains/main/blocks/head

# Test fallback RPC
curl $TEZOS_FALLBACK_RPC_URL/chains/main/blocks/head

# Check network connectivity
ping rpc.tzkt.io

# Review RPC metrics
curl localhost:9090/metrics | grep tezos_rpc
```

**Solutions:**
- Switch to fallback RPC if primary is down
- Increase retry attempts and timeouts
- Use multiple RPC providers
- Implement circuit breaker pattern

### Invalid Baker Address

**Symptoms:**
- "Invalid address" errors
- Baker not found
- Balance returns 0

**Diagnosis:**
```bash
# Validate baker address format
echo "tz1..." | grep -E '^tz1[a-zA-Z0-9]{33}$'

# Check address on explorer
curl https://api.tzkt.io/v1/accounts/tz1.../

# Verify in database
psql $DATABASE_URL -c "SELECT bakerId, address FROM settings;"
```

**Solutions:**
- Verify baker address format (tz1... with 36 chars total)
- Check address is correct for network (mainnet vs testnet)
- Ensure baker is registered on-chain
- Update address in settings

### Payment Distribution Failures

**Symptoms:**
- Distribution returns error
- Payments not sent
- Simulation mode stuck

**Diagnosis:**
```bash
# Check baker mode
psql $DATABASE_URL -c "SELECT bakerId, mode FROM settings;"

# Check wallet configuration
psql $DATABASE_URL -c "SELECT bakerId, phrase IS NOT NULL as has_wallet FROM settings;"

# Review distribution logs
grep "distribution" /var/log/taps/app.log | tail -20

# Check payment records
psql $DATABASE_URL -c "SELECT cycle, result, errorMessage FROM payment ORDER BY cycle DESC LIMIT 10;"
```

**Solutions:**
- Verify mode is set correctly (simulation/on/off)
- Check wallet credentials are configured
- Verify sufficient baker balance
- Review error messages in payment records

## Performance Issues

### Slow Response Times

**Symptoms:**
- API requests take > 2 seconds
- Timeouts
- Poor user experience

**Diagnosis:**
```bash
# Check response times
curl -w "@curl-format.txt" -o /dev/null -s https://api.example.com/health

# Review metrics
curl localhost:9090/metrics | grep http_request_duration

# Check database performance
psql $DATABASE_URL -c "SELECT query, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# Profile application
node --prof dist/main.js
```

**Solutions:**
- Add caching layer (Redis)
- Optimize database queries
- Implement pagination
- Use CDN for static assets
- Enable compression

### Memory Leaks

**Symptoms:**
- Memory usage grows over time
- OOM kills
- Degraded performance

**Diagnosis:**
```bash
# Monitor memory over time
watch -n 5 'docker stats --no-stream'

# Generate heap snapshot
node --inspect dist/main.js
# Then use Chrome DevTools

# Check for connection leaks
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'taps';"
```

**Solutions:**
- Profile memory usage with Chrome DevTools
- Check for unclosed database connections
- Review event listener cleanup
- Implement proper resource disposal

### Database Lock Contention

**Symptoms:**
- Deadlock errors
- Long-running transactions
- High lock wait times

**Diagnosis:**
```bash
# Check for locks
psql $DATABASE_URL -c "SELECT * FROM pg_locks WHERE NOT granted;"

# Check long-running queries
psql $DATABASE_URL -c "SELECT pid, now() - query_start as duration, query FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 seconds';"

# Check for deadlocks
grep "deadlock" /var/log/postgresql/postgresql.log
```

**Solutions:**
- Use transactions properly
- Implement optimistic locking
- Reduce transaction scope
- Add proper indexes

## Deployment Issues

### Docker Build Fails

**Symptoms:**
- Build exits with error
- Dependencies not installed
- Compilation errors

**Diagnosis:**
```bash
# Build with verbose output
docker build --no-cache --progress=plain -t taps-backend .

# Check Dockerfile syntax
docker build --check -t taps-backend .

# Verify dependencies
npm ci
npm run build
```

**Solutions:**
- Clear Docker cache
- Verify package.json and package-lock.json
- Check Node version compatibility
- Review Dockerfile multi-stage builds

### Health Checks Failing

**Symptoms:**
- ECS tasks marked unhealthy
- Container restarts
- Load balancer removes instance

**Diagnosis:**
```bash
# Test health endpoint locally
curl http://localhost:3000/health

# Check health check configuration
aws ecs describe-services --cluster prod --services taps-backend --query 'services[0].healthCheckGracePeriodSeconds'

# Review container logs
docker logs <container_id>
```

**Solutions:**
- Increase health check grace period
- Fix issues causing health check failures
- Verify database connectivity
- Check Tezos RPC accessibility

### Rollback Required

**Symptoms:**
- New deployment causing errors
- Critical bugs in production
- Need to revert changes

**Steps:**
```bash
# 1. Identify previous version
aws ecs describe-services --cluster prod --services taps-backend

# 2. Update to previous task definition
aws ecs update-service \
  --cluster prod \
  --service taps-backend \
  --task-definition taps-backend:PREVIOUS

# 3. Restore database if needed
./scripts/deployment/restore-database.sh <backup_file>

# 4. Verify rollback
curl https://api.example.com/health | jq .version
```

## Monitoring and Logging

### Logs Not Appearing

**Symptoms:**
- Missing logs in CloudWatch
- Empty log files
- Can't debug issues

**Diagnosis:**
```bash
# Check log configuration
cat /app/src/config/logger.config.ts

# Verify log driver
docker inspect <container_id> | grep LogConfig

# Check CloudWatch log group
aws logs describe-log-streams --log-group-name /ecs/taps-backend
```

**Solutions:**
- Verify log driver configuration
- Check CloudWatch permissions
- Ensure log level is appropriate
- Review Winston configuration

### Metrics Not Collected

**Symptoms:**
- Prometheus shows no data
- Metrics endpoint returns 404
- Grafana dashboards empty

**Diagnosis:**
```bash
# Test metrics endpoint
curl http://localhost:9090/metrics

# Check Prometheus configuration
cat /etc/prometheus/prometheus.yml

# Verify metrics service
curl localhost:9090/metrics | grep http_requests_total
```

**Solutions:**
- Verify ENABLE_METRICS=true
- Check metrics endpoint is exposed
- Review Prometheus scrape config
- Ensure network connectivity

### Sentry Errors Not Captured

**Symptoms:**
- Errors not appearing in Sentry
- No error notifications
- Missing stack traces

**Diagnosis:**
```bash
# Check Sentry DSN
echo $SENTRY_DSN

# Test Sentry integration
node -e "const Sentry = require('@sentry/node'); Sentry.init({dsn: process.env.SENTRY_DSN}); Sentry.captureMessage('test');"

# Review Sentry configuration
cat /app/src/modules/monitoring/services/sentry.service.ts
```

**Solutions:**
- Verify SENTRY_DSN is configured
- Check Sentry project settings
- Review error filtering logic
- Ensure Sentry is initialized

## Getting Help

### Before Asking for Help

1. Check this troubleshooting guide
2. Review application logs
3. Check monitoring dashboards
4. Search existing issues on GitHub
5. Test in staging environment

### Information to Provide

When reporting an issue, include:

- Environment (production/staging/dev)
- Timestamp of issue
- Steps to reproduce
- Error messages and logs
- Screenshots if applicable
- Impact and severity

### Contact Information

- **Slack**: #taps-support
- **Email**: ops@example.com
- **On-Call**: [PagerDuty]
- **GitHub Issues**: https://github.com/org/taps/issues

## Useful Commands Reference

```bash
# Application
docker logs -f <container>
docker exec -it <container> sh
docker stats <container>

# Database
psql $DATABASE_URL
psql $DATABASE_URL -c "SELECT * FROM _prisma_migrations;"
npx prisma studio

# Monitoring
curl localhost:9090/metrics
curl localhost:3000/health
aws logs tail /ecs/taps-backend --follow

# AWS
aws ecs list-tasks --cluster prod
aws ecs describe-tasks --cluster prod --tasks <task_id>
aws ecs update-service --cluster prod --service taps --force-new-deployment

# Debugging
node --inspect dist/main.js
npm run test:debug
npx prisma migrate status
```
