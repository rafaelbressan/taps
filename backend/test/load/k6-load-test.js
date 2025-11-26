/**
 * K6 Load Testing Script for TAPS Backend
 *
 * Run with: k6 run test/load/k6-load-test.js
 *
 * Install k6: https://k6.io/docs/getting-started/installation/
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const loginDuration = new Trend('login_duration');
const settingsDuration = new Trend('settings_duration');
const paymentsDuration = new Trend('payments_duration');

// Test configuration
export const options = {
  stages: [
    { duration: '1m', target: 10 },   // Warm-up: ramp to 10 users
    { duration: '3m', target: 50 },   // Ramp-up: ramp to 50 users
    { duration: '5m', target: 50 },   // Sustained: stay at 50 users
    { duration: '1m', target: 100 },  // Spike: jump to 100 users
    { duration: '2m', target: 100 },  // Sustained spike
    { duration: '1m', target: 0 },    // Cool-down: ramp down to 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<1500'], // 95% < 1s, 99% < 1.5s
    http_req_failed: ['rate<0.01'], // Error rate < 1%
    errors: ['rate<0.01'],
  },
};

// Base URL
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Test data
const TEST_USER = {
  username: 'testbaker',
  password: 'TestPassword123!',
};

/**
 * Login and return auth token
 */
function login() {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify(TEST_USER),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'Login' },
    }
  );

  loginDuration.add(res.timings.duration);

  const success = check(res, {
    'login status is 200': (r) => r.status === 200,
    'login has token': (r) => r.json('access_token') !== undefined,
  });

  errorRate.add(!success);

  return success ? res.json('access_token') : null;
}

/**
 * Main test scenario
 */
export default function () {
  // 1. Authentication flow
  group('Authentication', () => {
    const token = login();

    if (!token) {
      console.error('Login failed, skipping authenticated requests');
      return;
    }

    sleep(1);

    // Get current user
    const meRes = http.get(`${BASE_URL}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'GetCurrentUser' },
    });

    check(meRes, {
      'get user status is 200': (r) => r.status === 200,
      'user has baker_id': (r) => r.json('baker_id') !== undefined,
    });

    sleep(2);
  });

  // 2. Settings management
  group('Settings', () => {
    const token = login();

    if (!token) return;

    sleep(1);

    // Get settings
    const getSettingsRes = http.get(`${BASE_URL}/settings`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'GetSettings' },
    });

    settingsDuration.add(getSettingsRes.timings.duration);

    check(getSettingsRes, {
      'get settings status is 200': (r) => r.status === 200,
      'settings has default_fee': (r) => r.json('default_fee') !== undefined,
    });

    sleep(2);

    // Update settings
    const updateRes = http.patch(
      `${BASE_URL}/settings`,
      JSON.stringify({
        defaultFee: 5.5,
        minPayment: 0.5,
      }),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        tags: { name: 'UpdateSettings' },
      }
    );

    check(updateRes, {
      'update settings status is 200': (r) => r.status === 200,
    });

    sleep(1);

    // Get system status
    const statusRes = http.get(`${BASE_URL}/settings/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'GetSystemStatus' },
    });

    check(statusRes, {
      'system status is 200': (r) => r.status === 200,
      'status has mode': (r) => r.json('mode') !== undefined,
    });

    sleep(1);
  });

  // 3. Payment history
  group('Payments', () => {
    const token = login();

    if (!token) return;

    sleep(1);

    // Get payment history
    const historyRes = http.get(`${BASE_URL}/payments/history?page=1&limit=20`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'GetPaymentHistory' },
    });

    paymentsDuration.add(historyRes.timings.duration);

    check(historyRes, {
      'payment history status is 200': (r) => r.status === 200,
      'history has data': (r) => r.json('data') !== undefined,
      'history has pagination': (r) => r.json('total') !== undefined,
    });

    sleep(3);

    // Get pending cycle
    const pendingRes = http.get(`${BASE_URL}/payments/pending`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'GetPendingCycle' },
    });

    check(pendingRes, {
      'pending cycle status is 200': (r) => r.status === 200,
      'pending has cycle': (r) => r.json('cycle') !== undefined,
    });

    sleep(2);
  });

  // 4. Job management
  group('Jobs', () => {
    const token = login();

    if (!token) return;

    sleep(1);

    // Get job status
    const statusRes = http.get(`${BASE_URL}/jobs/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'GetJobStatus' },
    });

    check(statusRes, {
      'job status is 200': (r) => r.status === 200,
      'status has cycle monitoring': (r) => r.json('cycleMonitoring') !== undefined,
    });

    sleep(2);

    // Trigger cycle check
    const triggerRes = http.post(
      `${BASE_URL}/jobs/trigger/cycle-check`,
      null,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        tags: { name: 'TriggerCycleCheck' },
      }
    );

    check(triggerRes, {
      'trigger cycle check is 202': (r) => r.status === 202,
    });

    sleep(1);
  });

  sleep(1); // Think time between iterations
}

/**
 * Test setup
 */
export function setup() {
  console.log(`Starting load test against: ${BASE_URL}`);
  console.log('Test phases:');
  console.log('  1. Warm-up: 1m to 10 users');
  console.log('  2. Ramp-up: 3m to 50 users');
  console.log('  3. Sustained: 5m at 50 users');
  console.log('  4. Spike: 1m to 100 users');
  console.log('  5. Sustained spike: 2m at 100 users');
  console.log('  6. Cool-down: 1m to 0 users');
  console.log('');
  console.log('Thresholds:');
  console.log('  - 95th percentile < 1000ms');
  console.log('  - 99th percentile < 1500ms');
  console.log('  - Error rate < 1%');
  console.log('');

  // Verify API is reachable
  const healthCheck = http.get(BASE_URL);
  if (healthCheck.status !== 404 && healthCheck.status !== 401) {
    console.log(`✓ API is reachable (status: ${healthCheck.status})`);
  } else {
    console.warn(`⚠ API returned status: ${healthCheck.status}`);
  }

  return { startTime: new Date().toISOString() };
}

/**
 * Test teardown
 */
export function teardown(data) {
  console.log('');
  console.log('Load test completed!');
  console.log(`Started at: ${data.startTime}`);
  console.log(`Ended at: ${new Date().toISOString()}`);
  console.log('');
  console.log('Check the output above for detailed metrics and threshold results.');
}

/**
 * Custom summary for test results
 */
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'test/load/k6-results.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, options) {
  const indent = options.indent || '';
  const colors = options.enableColors !== false;

  let summary = '\n';
  summary += `${indent}============================================\n`;
  summary += `${indent}         K6 Load Test Summary\n`;
  summary += `${indent}============================================\n\n`;

  // Request metrics
  if (data.metrics.http_reqs) {
    summary += `${indent}Total Requests: ${data.metrics.http_reqs.values.count}\n`;
    summary += `${indent}Request Rate: ${data.metrics.http_reqs.values.rate.toFixed(2)}/s\n\n`;
  }

  // Response time metrics
  if (data.metrics.http_req_duration) {
    const duration = data.metrics.http_req_duration.values;
    summary += `${indent}Response Time:\n`;
    summary += `${indent}  Average: ${duration.avg.toFixed(2)}ms\n`;
    summary += `${indent}  Min: ${duration.min.toFixed(2)}ms\n`;
    summary += `${indent}  Max: ${duration.max.toFixed(2)}ms\n`;
    summary += `${indent}  p(50): ${duration.p50.toFixed(2)}ms\n`;
    summary += `${indent}  p(95): ${duration.p95.toFixed(2)}ms\n`;
    summary += `${indent}  p(99): ${duration.p99.toFixed(2)}ms\n\n`;
  }

  // Error rate
  if (data.metrics.http_req_failed) {
    const failRate = (data.metrics.http_req_failed.values.rate * 100).toFixed(2);
    summary += `${indent}Error Rate: ${failRate}%\n\n`;
  }

  // Custom metrics
  if (data.metrics.login_duration) {
    summary += `${indent}Login Duration (avg): ${data.metrics.login_duration.values.avg.toFixed(2)}ms\n`;
  }
  if (data.metrics.settings_duration) {
    summary += `${indent}Settings Duration (avg): ${data.metrics.settings_duration.values.avg.toFixed(2)}ms\n`;
  }
  if (data.metrics.payments_duration) {
    summary += `${indent}Payments Duration (avg): ${data.metrics.payments_duration.values.avg.toFixed(2)}ms\n`;
  }

  summary += `\n${indent}============================================\n`;

  return summary;
}
