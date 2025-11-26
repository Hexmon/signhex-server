import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { initializeS3, createBucketIfNotExists } from '../src/s3/index.js';

type TestResult = {
  name: string;
  purpose: string;
  method: string;
  endpoint: string;
  status: number | null;
  success: boolean;
  durationMs: number;
  request?: any;
  response?: any;
  responsePreview?: string;
  note?: string;
  error?: string;
};

type HttpResult = {
  ok: boolean;
  status: number | null;
  data?: any;
  duration?: number;
  error?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const reportDir = path.join(projectRoot, 'reports');
const reportPath = path.join(reportDir, 'api-test-report.md');

const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const adminEmail = process.env.ADMIN_EMAIL || 'admin@hexmon.local';
const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

const results: TestResult[] = [];
let bearerToken: string | null = null;
let bucketsReady = false;

const state: Record<string, string> = {};

function redactString(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sanitize(data: any, keyPath = ''): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    if (/token|password|secret|key/i.test(keyPath)) {
      return redactString(data);
    }
    return data;
  }
  if (typeof data !== 'object') {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item, index) => sanitize(item, `${keyPath}[${index}]`));
  }
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, sanitize(v, keyPath ? `${keyPath}.${k}` : k)])
  );
}

function preview(data: any): string {
  if (data === null || data === undefined) return '';
  const sanitized = sanitize(data);
  const str =
    typeof sanitized === 'string'
      ? sanitized
      : JSON.stringify(sanitized, null, 2);
  return str.length > 600 ? `${str.slice(0, 600)}...` : str;
}

async function httpRequest(
  method: string,
  endpoint: string,
  options: { body?: any; auth?: boolean } = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth) {
    if (!bearerToken) {
      return { ok: false, status: null, error: 'Missing auth token' };
    }
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }

  try {
    const started = performance.now();
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const duration = performance.now() - started;

    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();
    let data: any = rawBody;

    if (rawBody && contentType.includes('application/json')) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = rawBody;
      }
    } else if (!rawBody) {
      data = null;
    }

    return { ok: response.ok, status: response.status, data, duration };
  } catch (error: any) {
    return {
      ok: false,
      status: null,
      error: error?.message || String(error),
    };
  }
}

function recordResult(entry: TestResult) {
  results.push(entry);
  const statusLabel = entry.status === null ? 'ERR' : entry.status;
  const flag = entry.success ? 'OK' : 'FAIL';
  console.log(`[${flag}] ${entry.name} (${statusLabel})`);
}

async function runTest(
  name: string,
  purpose: string,
  method: string,
  endpoint: string,
  body?: any,
  opts: { auth?: boolean; note?: string } = {}
): Promise<HttpResult> {
  const started = performance.now();
  const response = await httpRequest(method, endpoint, { body, auth: opts.auth });
  const duration = performance.now() - started;

  const sanitizedResponse = response.data ? sanitize(response.data) : undefined;
  const entry: TestResult = {
    name,
    purpose,
    method,
    endpoint,
    status: response.status,
    success: response.ok,
    durationMs: Math.round(duration),
    request: body ? sanitize(body) : undefined,
    response: sanitizedResponse,
    responsePreview: sanitizedResponse ? preview(sanitizedResponse) : undefined,
    note: opts.note,
    error: response.error,
  };

  recordResult(entry);
  return response;
}

async function ensureBuckets() {
  try {
    initializeS3();
    const buckets = ['logs-heartbeats', 'logs-proof-of-play', 'device-screenshots'];
    for (const bucket of buckets) {
      await createBucketIfNotExists(bucket);
    }
    bucketsReady = true;
    recordResult({
      name: 'Storage buckets',
      purpose: 'Ensure MinIO buckets exist for telemetry endpoints',
      method: 'N/A',
      endpoint: 'minio',
      status: 200,
      success: true,
      durationMs: 0,
      note: 'Buckets verified/created',
    });
  } catch (error: any) {
    bucketsReady = false;
    recordResult({
      name: 'Storage buckets',
      purpose: 'Ensure MinIO buckets exist for telemetry endpoints',
      method: 'N/A',
      endpoint: 'minio',
      status: null,
      success: false,
      durationMs: 0,
      error: error?.message || String(error),
      note: 'Device telemetry tests may fail if buckets are missing',
    });
  }
}

async function main() {
  console.log(`Running API tests against ${baseUrl}`);
  await ensureBuckets();

  // Health
  await runTest('Health', 'Service health probe', 'GET', '/health');

  // Auth: login
  const loginRes = await runTest(
    'Auth: login',
    'Authenticate admin user',
    'POST',
    '/v1/auth/login',
    { email: adminEmail, password: adminPassword }
  );
  if (loginRes.ok && loginRes.data?.token) {
    bearerToken = loginRes.data.token;
  }

  // Auth: me
  await runTest('Auth: me', 'Fetch current user profile', 'GET', '/v1/auth/me', undefined, { auth: true });

  // Departments
  const deptPayload = {
    name: `QA Dept ${Date.now()}`,
    description: 'Temporary department created by api-test-report',
  };
  const deptCreate = await runTest(
    'Departments: create',
    'Create a department',
    'POST',
    '/v1/departments',
    deptPayload,
    { auth: true }
  );
  if (deptCreate.ok && deptCreate.data?.id) {
    state.departmentId = deptCreate.data.id;
  }
  await runTest('Departments: list', 'List departments', 'GET', '/v1/departments?page=1&limit=10', undefined, {
    auth: true,
  });
  if (state.departmentId) {
    await runTest(
      'Departments: get',
      'Get department by id',
      'GET',
      `/v1/departments/${state.departmentId}`,
      undefined,
      { auth: true }
    );
    await runTest(
      'Departments: update',
      'Update department description',
      'PATCH',
      `/v1/departments/${state.departmentId}`,
      { description: 'Updated via API test' },
      { auth: true }
    );
    await runTest(
      'Departments: delete',
      'Delete department',
      'DELETE',
      `/v1/departments/${state.departmentId}`,
      undefined,
      { auth: true }
    );
  }

  // Users
  const userPayload = {
    email: `qa+${Date.now()}@hexmon.local`,
    password: 'TestPass123!',
    first_name: 'QA',
    last_name: 'User',
    role: 'OPERATOR',
  };
  const userCreate = await runTest('Users: create', 'Create user', 'POST', '/v1/users', userPayload, {
    auth: true,
  });
  if (userCreate.ok && userCreate.data?.id) {
    state.userId = userCreate.data.id;
  }
  await runTest('Users: list', 'List users', 'GET', '/v1/users?page=1&limit=10', undefined, { auth: true });
  if (state.userId) {
    await runTest('Users: get', 'Get user by id', 'GET', `/v1/users/${state.userId}`, undefined, { auth: true });
    await runTest(
      'Users: update',
      'Update user name',
      'PATCH',
      `/v1/users/${state.userId}`,
      { first_name: 'Updated', last_name: 'User' },
      { auth: true }
    );
    await runTest('Users: delete', 'Delete user', 'DELETE', `/v1/users/${state.userId}`, undefined, { auth: true });
  }

  // Media presign + upload + finalize
  const presignPayload = {
    filename: 'sample.txt',
    content_type: 'text/plain',
    size: 24,
  };
  const presign = await runTest(
    'Media: presign',
    'Get presigned upload URL',
    'POST',
    '/v1/media/presign-upload',
    presignPayload,
    { auth: true }
  );
  if (presign.ok && presign.data?.upload_url) {
    state.mediaId = presign.data.media_id;
    try {
      const uploadRes = await fetch(presign.data.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': presignPayload.content_type },
        body: 'hello from api-test',
      });
      recordResult({
        name: 'Media: upload',
        purpose: 'Upload sample object to MinIO via presigned URL',
        method: 'PUT',
        endpoint: 'minio presigned URL',
        status: uploadRes.status,
        success: uploadRes.ok,
        durationMs: 0,
        note: uploadRes.ok ? 'Upload successful' : 'Upload failed',
      });
      if (uploadRes.ok) {
        await runTest(
          'Media: complete',
          'Finalize upload',
          'POST',
          `/v1/media/${state.mediaId}/complete`,
          { status: 'READY', size: presignPayload.size },
          { auth: true }
        );
      }
    } catch (error: any) {
      recordResult({
        name: 'Media: upload',
        purpose: 'Upload sample object to MinIO via presigned URL',
        method: 'PUT',
        endpoint: 'minio presigned URL',
        status: null,
        success: false,
        durationMs: 0,
        error: error?.message || String(error),
      });
    }
  }

  // Media metadata create/list/get
  const mediaCreate = await runTest(
    'Media: create metadata',
    'Create media record without upload',
    'POST',
    '/v1/media',
    { name: `Test Media ${Date.now()}`, type: 'IMAGE' },
    { auth: true }
  );
  if (!state.mediaId && mediaCreate.ok && mediaCreate.data?.id) {
    state.mediaId = mediaCreate.data.id;
  }
  await runTest('Media: list', 'List media', 'GET', '/v1/media?page=1&limit=10', undefined, { auth: true });
  if (state.mediaId) {
    await runTest('Media: get', 'Get media by id', 'GET', `/v1/media/${state.mediaId}`, undefined, { auth: true });
  }

  // Screens
  const screenCreate = await runTest(
    'Screens: create',
    'Create screen',
    'POST',
    '/v1/screens',
    { name: `QA Screen ${Date.now()}`, location: 'QA Lab' },
    { auth: true }
  );
  if (screenCreate.ok && screenCreate.data?.id) {
    state.screenId = screenCreate.data.id;
  }
  await runTest('Screens: list', 'List screens', 'GET', '/v1/screens?page=1&limit=10', undefined, { auth: true });
  if (state.screenId) {
    await runTest('Screens: get', 'Get screen by id', 'GET', `/v1/screens/${state.screenId}`, undefined, {
      auth: true,
    });
    await runTest(
      'Screens: update',
      'Update screen location',
      'PATCH',
      `/v1/screens/${state.screenId}`,
      { location: 'QA Updated' },
      { auth: true }
    );
  }

  // Presentations
  const presCreate = await runTest(
    'Presentations: create',
    'Create presentation',
    'POST',
    '/v1/presentations',
    { name: `QA Presentation ${Date.now()}`, description: 'Created by tests' },
    { auth: true }
  );
  if (presCreate.ok && presCreate.data?.id) {
    state.presentationId = presCreate.data.id;
  }
  await runTest(
    'Presentations: list',
    'List presentations',
    'GET',
    '/v1/presentations?page=1&limit=10',
    undefined,
    { auth: true }
  );
  if (state.presentationId) {
    await runTest(
      'Presentations: get',
      'Get presentation by id',
      'GET',
      `/v1/presentations/${state.presentationId}`,
      undefined,
      { auth: true }
    );
    await runTest(
      'Presentations: update',
      'Update presentation name',
      'PATCH',
      `/v1/presentations/${state.presentationId}`,
      { name: 'QA Presentation Updated' },
      { auth: true }
    );
  }

  // Schedules
  const startAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const scheduleCreate = await runTest(
    'Schedules: create',
    'Create schedule',
    'POST',
    '/v1/schedules',
    {
      name: `QA Schedule ${Date.now()}`,
      description: 'Created by tests',
      start_at: startAt,
      end_at: endAt,
    },
    { auth: true }
  );
  if (scheduleCreate.ok && scheduleCreate.data?.id) {
    state.scheduleId = scheduleCreate.data.id;
  }
  await runTest('Schedules: list', 'List schedules', 'GET', '/v1/schedules?page=1&limit=10', undefined, {
    auth: true,
  });
  if (state.scheduleId) {
    await runTest(
      'Schedules: get',
      'Get schedule by id',
      'GET',
      `/v1/schedules/${state.scheduleId}`,
      undefined,
      { auth: true }
    );
    await runTest(
      'Schedules: update',
      'Update schedule name',
      'PATCH',
      `/v1/schedules/${state.scheduleId}`,
      { name: 'QA Schedule Updated' },
      { auth: true }
    );
    if (state.screenId) {
      const publishRes = await runTest(
        'Schedules: publish',
        'Publish schedule to screen',
        'POST',
        `/v1/schedules/${state.scheduleId}/publish`,
        { screen_ids: [state.screenId] },
        { auth: true }
      );
      if (publishRes.ok && publishRes.data?.publish_id) {
        state.publishId = publishRes.data.publish_id;
        await runTest(
          'Schedules: publishes',
          'List publish history for schedule',
          'GET',
          `/v1/schedules/${state.scheduleId}/publishes`,
          undefined,
          { auth: true }
        );
        await runTest(
          'Publishes: get',
          'Get publish record',
          'GET',
          `/v1/publishes/${state.publishId}`,
          undefined,
          { auth: true }
        );
      }
    }
  }

  // Requests (Kanban)
  const requestCreate = await runTest(
    'Requests: create',
    'Create request ticket',
    'POST',
    '/v1/requests',
    { title: 'QA request', description: 'Created by api test', priority: 'HIGH' },
    { auth: true }
  );
  if (requestCreate.ok && requestCreate.data?.id) {
    state.requestId = requestCreate.data.id;
  }
  await runTest('Requests: list', 'List requests', 'GET', '/v1/requests?page=1&limit=10', undefined, {
    auth: true,
  });
  if (state.requestId) {
    await runTest(
      'Requests: get',
      'Get request by id',
      'GET',
      `/v1/requests/${state.requestId}`,
      undefined,
      { auth: true }
    );
    await runTest(
      'Requests: update',
      'Update request status',
      'PATCH',
      `/v1/requests/${state.requestId}`,
      { status: 'IN_PROGRESS' },
      { auth: true }
    );
    await runTest(
      'Requests: add message',
      'Add message to request',
      'POST',
      `/v1/requests/${state.requestId}/messages`,
      { message: 'Message from API tests' },
      { auth: true }
    );
    await runTest(
      'Requests: list messages',
      'List request messages',
      'GET',
      `/v1/requests/${state.requestId}/messages?page=1&limit=10`,
      undefined,
      { auth: true }
    );
  }

  // Emergency
  const statusBefore = await runTest(
    'Emergency: status (before)',
    'Check current emergency status',
    'GET',
    '/v1/emergency/status',
    undefined,
    { auth: true }
  );
  if (statusBefore.ok && statusBefore.data?.active && statusBefore.data.emergency?.id) {
    await runTest(
      'Emergency: clear existing',
      'Clear pre-existing emergency',
      'POST',
      `/v1/emergency/${statusBefore.data.emergency.id}/clear`,
      undefined,
      { auth: true }
    );
  }
  const trigger = await runTest(
    'Emergency: trigger',
    'Trigger emergency alert',
    'POST',
    '/v1/emergency/trigger',
    { message: 'Test emergency message', severity: 'LOW' },
    { auth: true }
  );
  if (trigger.ok && trigger.data?.id) {
    state.emergencyId = trigger.data.id;
  }
  await runTest(
    'Emergency: status (after)',
    'Check emergency status after trigger',
    'GET',
    '/v1/emergency/status',
    undefined,
    { auth: true }
  );
  if (state.emergencyId) {
    await runTest(
      'Emergency: clear',
      'Clear triggered emergency',
      'POST',
      `/v1/emergency/${state.emergencyId}/clear`,
      undefined,
      { auth: true }
    );
  }
  await runTest(
    'Emergency: history',
    'List emergency history',
    'GET',
    '/v1/emergency/history?page=1&limit=10',
    undefined,
    { auth: true }
  );

  // Notifications
  await runTest(
    'Notifications: list',
    'List notifications',
    'GET',
    '/v1/notifications?page=1&limit=10',
    undefined,
    { auth: true }
  );
  await runTest(
    'Notifications: mark all read',
    'Mark all notifications as read',
    'POST',
    '/v1/notifications/read-all',
    undefined,
    { auth: true }
  );

  // Audit logs
  await runTest(
    'Audit logs: list',
    'List audit logs',
    'GET',
    '/v1/audit-logs?page=1&limit=10',
    undefined,
    { auth: true }
  );

  // Device pairing
  const pairing = await runTest(
    'Device pairing: generate',
    'Generate device pairing code',
    'POST',
    '/v1/device-pairing/generate',
    { device_id: state.screenId || randomUUID(), expires_in: 600 },
    { auth: true }
  );
  if (pairing.ok && pairing.data?.pairing_code) {
    state.pairingCode = pairing.data.pairing_code;
  }
  await runTest(
    'Device pairing: list',
    'List device pairings',
    'GET',
    '/v1/device-pairing?page=1&limit=10',
    undefined,
    { auth: true }
  );

  // Device telemetry (heartbeat/proof of play/screenshot/commands)
  if (state.screenId && bucketsReady) {
    await runTest(
      'Device heartbeat',
      'Post heartbeat for device',
      'POST',
      '/v1/device/heartbeat',
      {
        device_id: state.screenId,
        status: 'ONLINE',
        uptime: 120,
        memory_usage: 256,
        cpu_usage: 25,
        temperature: 50,
        current_schedule_id: state.scheduleId,
        current_media_id: state.mediaId,
      },
      { auth: false }
    );
    await runTest(
      'Device proof-of-play',
      'Submit proof-of-play log',
      'POST',
      '/v1/device/proof-of-play',
      {
        device_id: state.screenId,
        media_id: state.mediaId || 'media-placeholder',
        schedule_id: state.scheduleId || 'schedule-placeholder',
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 120000).toISOString(),
        duration: 120,
        completed: true,
      }
    );
    await runTest(
      'Device screenshot',
      'Upload device screenshot',
      'POST',
      '/v1/device/screenshot',
      {
        device_id: state.screenId,
        timestamp: new Date().toISOString(),
        image_data: Buffer.from('hello').toString('base64'),
      }
    );
    await runTest(
      'Device commands',
      'Fetch pending device commands',
      'GET',
      `/v1/device/${state.screenId}/commands`
    );
  } else {
    recordResult({
      name: 'Device telemetry',
      purpose: 'Skipped because screen or buckets missing',
      method: 'POST',
      endpoint: '/v1/device/*',
      status: null,
      success: false,
      durationMs: 0,
      note: 'Device telemetry tests require screen id and MinIO buckets',
    });
  }

  // Media proof of play reports listing endpoint
  await runTest(
    'Proof of play: list',
    'List proof-of-play records',
    'GET',
    '/v1/proof-of-play?page=1&limit=10',
    undefined,
    { auth: true }
  );

  // Final clean-up delete for screen/presentation (best effort)
  if (state.screenId) {
    await runTest('Screens: delete', 'Delete screen', 'DELETE', `/v1/screens/${state.screenId}`, undefined, {
      auth: true,
    });
  }
  if (state.presentationId) {
    await runTest(
      'Presentations: delete',
      'Delete presentation',
      'DELETE',
      `/v1/presentations/${state.presentationId}`,
      undefined,
      { auth: true }
    );
  }

  writeReport();
}

function writeReport() {
  mkdirSync(reportDir, { recursive: true });

  const passed = results.filter((r) => r.success).length;
  const failed = results.length - passed;

  const summaryLines = results
    .map(
      (r) =>
        `| ${r.name} | ${r.method} | ${r.endpoint} | ${r.status ?? 'ERR'} | ${
          r.success ? '✅' : '❌'
        } | ${r.note || ''} |`
    )
    .join('\n');

  const detailBlocks = results
    .map((r) => {
      const parts = [
        `### ${r.name}`,
        `- Purpose: ${r.purpose}`,
        `- Method: ${r.method}`,
        `- Endpoint: ${r.endpoint}`,
        `- Status: ${r.status ?? 'ERR'} (${r.success ? 'pass' : 'fail'})`,
        r.request ? `- Request: \`${JSON.stringify(r.request)}\`` : undefined,
        r.responsePreview ? `- Response: \`${r.responsePreview}\`` : undefined,
        r.error ? `- Error: ${r.error}` : undefined,
        r.note ? `- Note: ${r.note}` : undefined,
      ].filter(Boolean);
      return parts.join('\n');
    })
    .join('\n\n');

  const markdown = `# API Test Report

- Timestamp: ${new Date().toISOString()}
- Base URL: ${baseUrl}
- Auth user: ${adminEmail}
- Total: ${results.length}, Passed: ${passed}, Failed: ${failed}

| Test | Method | Endpoint | Status | Result | Notes |
| --- | --- | --- | --- | --- | --- |
${summaryLines}

## Details

${detailBlocks}
`;

  writeFileSync(reportPath, markdown, { encoding: 'utf8' });
  console.log(`\nReport written to ${reportPath}`);
}

main().catch((error) => {
  console.error('API test runner failed:', error);
  process.exit(1);
});
