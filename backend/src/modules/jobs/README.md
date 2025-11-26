# Jobs Module

Background job system for automated cycle monitoring and reward distribution.

## Overview

Replaces ColdFusion scheduled tasks (script_fetch.cfm) with a robust, scalable job queue system using Bull and Redis.

## Architecture

### Queues

1. **cycle-monitoring** - Monitors blockchain for cycle changes
2. **reward-distribution** - Distributes rewards to delegators
3. **blockchain-polling** - Polls blockchain for balance updates
4. **bond-pool** - Handles bond pool distributions

### Processors

#### CycleMonitorProcessor
- Runs every N minutes (configurable via `settings.update_freq`)
- Detects Tezos cycle changes
- Triggers reward distribution when rewards become available
- Skips processing when mode is 'off'

#### RewardDistributionProcessor
- Processes reward distribution for specific cycles
- Supports simulation and live modes
- Automatic retry with exponential backoff
- Triggers bond pool distribution if enabled

#### BlockchainPollProcessor
- Polls baker balance every 5 minutes
- Caches balance in Redis for quick access
- Useful for UI real-time updates

### Services

#### JobSchedulerService
- Manages recurring job schedules
- Initializes jobs on application startup
- Updates schedules when settings change
- Provides manual trigger capabilities

## API Endpoints

### Manual Triggers
- `POST /api/jobs/trigger/cycle-check` - Manually trigger cycle check
- `POST /api/jobs/trigger/balance-poll` - Manually trigger balance poll

### Management
- `GET /api/jobs/status` - Get status of scheduled jobs
- `POST /api/jobs/initialize` - Initialize job schedules
- `POST /api/jobs/remove` - Remove job schedules

## Configuration

### Environment Variables

```env
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Settings (per baker)

- `update_freq` - Cycle check frequency in minutes (default: 10)
- `payment_retries` - Number of retry attempts for failed distributions (default: 1)
- `minutes_between_retries` - Delay between retries in minutes (default: 1)

## Usage

### Initialize Schedules

When a baker first sets up their account:

```typescript
await jobScheduler.initializeSchedules(bakerId);
```

This creates:
- Cycle monitoring job (recurring every N minutes)
- Balance polling job (recurring every 5 minutes)

### Update Schedules

When settings change (e.g., update_freq):

```typescript
await jobScheduler.updateSchedule(bakerId);
```

### Manual Trigger

For testing or immediate execution:

```typescript
await jobScheduler.triggerCycleCheck(bakerId);
```

## Monitoring

### Bull Board (Development)

Access job monitoring dashboard at: `http://localhost:3000/admin/queues`

View:
- Active jobs
- Completed jobs
- Failed jobs
- Retry attempts
- Job statistics

### Logging

All processors log:
- Job start/completion
- Cycle changes detected
- Distributions executed
- Errors and failures

## Error Handling

### Retry Strategy

Failed distributions automatically retry with:
- Exponential backoff
- Configurable max attempts
- Detailed error logging

### Failure Handling

After max retries:
- Job marked as failed in database
- Error message stored
- Alert sent (TODO: implement alert service)

## Testing

### Manual Testing

1. Start Redis: `docker-compose up redis`
2. Initialize schedules: `POST /api/jobs/initialize`
3. Trigger manual check: `POST /api/jobs/trigger/cycle-check`
4. Monitor in Bull Board: `http://localhost:3000/admin/queues`

### Unit Tests

```bash
npm test -- jobs
```

## Migration from ColdFusion

### script_fetch.cfm → CycleMonitorProcessor

| ColdFusion | TypeScript |
|------------|------------|
| Scheduled task runs every N minutes | Bull repeatable job |
| Manual trigger via URL | POST /api/jobs/trigger/cycle-check |
| Checks settings.mode | Same logic |
| Calls distribution script | Queues reward-distribution job |

### Benefits over ColdFusion

✓ **Reliability** - Failed jobs automatically retry
✓ **Scalability** - Queue system handles high load
✓ **Monitoring** - Built-in job dashboard
✓ **Testability** - Easy to test job logic
✓ **Flexibility** - Easy to add new job types
✓ **Observability** - Comprehensive logging
