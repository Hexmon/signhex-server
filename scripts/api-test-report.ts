import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { initializeS3, createBucketIfNotExists } from '../src/s3/index.js';
import { apiEndpoints } from '../src/config/apiEndpoints.js';

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
const state: Record<string, string> = {};
let bearerToken: string | null = null;
let bucketsReady = false;

function redactString(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sanitize(data: any, keyPath = ''): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    if (/token|password|secret|key/i.test(keyPath)) return redactString(data);
    return data;
  }
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((item, index) => sanitize(item, `${keyPath}[${index}]`));
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, sanitize(v, keyPath ? `${keyPath}.${k}` : k)]));
}

function preview(data: any): string {
  if (data === null || data === undefined) return '';
  const sanitized = sanitize(data);
  const str = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized, null, 2);
  return str.length > 600 ? `${str.slice(0, 600)}...` : str;
}

async function httpRequest(
  method: string,
  endpoint: string,
  options: { body?: any; auth?: boolean } = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth) {
    if (!bearerToken) return { ok: false, status: null, error: 'Missing auth token' };
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
    return { ok: false, status: null, error: error?.message || String(error) };
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
  await runTest('Health', 'Check API health', 'GET', '/health');

  // Auth: login
  const loginRes = await runTest('Auth: login', 'Authenticate admin user', 'POST', apiEndpoints.auth.login, {
    email: adminEmail,
    password: adminPassword,
  });
  if (loginRes.ok) {
    bearerToken = loginRes.data?.token || loginRes.data?.access_token || loginRes.data?.accessToken || null;
  }

  // Auth: me
  await runTest('Auth: me', 'Get current user', 'GET', apiEndpoints.auth.me, undefined, { auth: true });

  // User invite + activate
  const inviteEmail = `qa-invite+${Date.now()}@hexmon.local`;
  const inviteRes = await runTest(
    'Users: invite',
    'Invite user',
    'POST',
    apiEndpoints.userInvite.invite,
    { email: inviteEmail, role: 'OPERATOR' },
    { auth: true }
  );
  if (inviteRes.ok && inviteRes.data?.invite_token) {
    await runTest(
      'Users: activate',
      'Activate invited user',
      'POST',
      apiEndpoints.userActivate.activate,
      { token: inviteRes.data.invite_token, password: 'TestPass123!' }
    );
  }

  // Departments
  const deptPayload = { name: `QA Dept ${Date.now()}`, description: 'Temporary department created by api-test-report' };
  const deptCreate = await runTest('Departments: create', 'Create a department', 'POST', apiEndpoints.departments.create, deptPayload, {
    auth: true,
  });
  if (deptCreate.ok && deptCreate.data?.id) state.departmentId = deptCreate.data.id;
  await runTest('Departments: list', 'List departments', 'GET', apiEndpoints.departments.list, undefined, { auth: true });
  if (state.departmentId) {
    await runTest(
      'Departments: get',
      'Get department by id',
      'GET',
      apiEndpoints.departments.get.replace(':id', state.departmentId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Departments: update',
      'Update department description',
      'PATCH',
      apiEndpoints.departments.update.replace(':id', state.departmentId),
      { description: 'Updated via API test' },
      { auth: true }
    );
    await runTest(
      'Departments: delete',
      'Delete department',
      'DELETE',
      apiEndpoints.departments.delete.replace(':id', state.departmentId),
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
  const userCreate = await runTest('Users: create', 'Create user', 'POST', apiEndpoints.users.create, userPayload, { auth: true });
  if (userCreate.ok && userCreate.data?.id) state.userId = userCreate.data.id;
  await runTest('Users: list', 'List users', 'GET', `${apiEndpoints.users.list}?page=1&limit=10`, undefined, { auth: true });
  if (state.userId) {
    await runTest(
      'Users: get',
      'Get user',
      'GET',
      apiEndpoints.users.get.replace(':id', state.userId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Users: update',
      'Update user name',
      'PATCH',
      apiEndpoints.users.update.replace(':id', state.userId),
      { first_name: 'Updated', last_name: 'User' },
      { auth: true }
    );
    await runTest('Users: delete', 'Delete user', 'DELETE', apiEndpoints.users.delete.replace(':id', state.userId), undefined, {
      auth: true,
    });
  }

  // Media presign + upload + finalize
  const presignPayload = { filename: 'sample.txt', content_type: 'text/plain', size: 24 };
  const presign = await runTest(
    'Media: presign',
    'Get presigned upload URL',
    'POST',
    apiEndpoints.media.presignUpload,
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
          apiEndpoints.media.complete.replace(':id', state.mediaId),
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
  await runTest(
    'Media: create metadata',
    'Create media metadata entry',
    'POST',
    apiEndpoints.media.create,
    { name: 'Test Media', type: 'IMAGE' },
    { auth: true }
  );
  await runTest('Media: list', 'List media', 'GET', `${apiEndpoints.media.list}?page=1&limit=10`, undefined, { auth: true });
  if (state.mediaId) {
    await runTest(
      'Media: get',
      'Get media by id',
      'GET',
      apiEndpoints.media.get.replace(':id', state.mediaId),
      undefined,
      { auth: true }
    );
  }

  // Screens
  const screenPayload = { name: `QA Screen ${Date.now()}`, location: 'QA Lab' };
  const screenCreate = await runTest('Screens: create', 'Create screen', 'POST', apiEndpoints.screens.create, screenPayload, {
    auth: true,
  });
  if (screenCreate.ok && screenCreate.data?.id) state.screenId = screenCreate.data.id;
  await runTest('Screens: list', 'List screens', 'GET', apiEndpoints.screens.list, undefined, { auth: true });
  if (state.screenId) {
    await runTest('Screens: get', 'Get screen by id', 'GET', apiEndpoints.screens.get.replace(':id', state.screenId), undefined, {
      auth: true,
    });
    await runTest(
      'Screens: update',
      'Update screen',
      'PATCH',
      apiEndpoints.screens.update.replace(':id', state.screenId),
      { location: 'Updated Lab' },
      { auth: true }
    );
  }

  // Presentations
  const presentationPayload = { name: `QA Presentation ${Date.now()}`, description: 'Created by tests' };
  const presentationCreate = await runTest(
    'Presentations: create',
    'Create presentation',
    'POST',
    apiEndpoints.presentations.create,
    presentationPayload,
    { auth: true }
  );
  if (presentationCreate.ok && presentationCreate.data?.id) state.presentationId = presentationCreate.data.id;
  await runTest(
    'Presentations: list',
    'List presentations',
    'GET',
    `${apiEndpoints.presentations.list}?page=1&limit=10`,
    undefined,
    { auth: true }
  );
  if (state.presentationId) {
    await runTest(
      'Presentations: get',
      'Get presentation by id',
      'GET',
      apiEndpoints.presentations.get.replace(':id', state.presentationId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Presentations: update',
      'Update presentation name',
      'PATCH',
      apiEndpoints.presentations.update.replace(':id', state.presentationId),
      { name: 'QA Presentation Updated' },
      { auth: true }
    );
    await runTest(
      'Presentations: delete',
      'Delete presentation',
      'DELETE',
      apiEndpoints.presentations.delete.replace(':id', state.presentationId),
      undefined,
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
    apiEndpoints.schedules.create,
    { name: `QA Schedule ${Date.now()}`, description: 'Created by tests', start_at: startAt, end_at: endAt },
    { auth: true }
  );
  if (scheduleCreate.ok && scheduleCreate.data?.id) state.scheduleId = scheduleCreate.data.id;
  await runTest('Schedules: list', 'List schedules', 'GET', `${apiEndpoints.schedules.list}?page=1&limit=10`, undefined, {
    auth: true,
  });
  if (state.scheduleId) {
    await runTest(
      'Schedules: get',
      'Get schedule by id',
      'GET',
      apiEndpoints.schedules.get.replace(':id', state.scheduleId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Schedules: update',
      'Update schedule name',
      'PATCH',
      apiEndpoints.schedules.update.replace(':id', state.scheduleId),
      { name: 'QA Schedule Updated' },
      { auth: true }
    );
    if (state.screenId) {
      const publishRes = await runTest(
        'Schedules: publish',
        'Publish schedule to screen',
        'POST',
        apiEndpoints.schedules.publish.replace(':id', state.scheduleId),
        { screen_ids: [state.screenId] },
        { auth: true }
      );
      if (publishRes.ok && publishRes.data?.publish_id) {
        state.publishId = publishRes.data.publish_id;
        await runTest(
          'Schedules: publishes',
          'List publish history for schedule',
          'GET',
          apiEndpoints.schedules.publishes.replace(':id', state.scheduleId),
          undefined,
          { auth: true }
        );
        await runTest(
          'Publishes: get',
          'Get publish record',
          'GET',
          apiEndpoints.schedules.publishStatus.replace(':id', state.publishId),
          undefined,
          { auth: true }
        );
      }
    }
  }

  // Requests
  const requestCreate = await runTest(
    'Requests: create',
    'Create request ticket',
    'POST',
    apiEndpoints.requests.create,
    { title: 'QA request', description: 'Created by api test', priority: 'HIGH' },
    { auth: true }
  );
  if (requestCreate.ok && requestCreate.data?.id) state.requestId = requestCreate.data.id;
  await runTest('Requests: list', 'List requests', 'GET', `${apiEndpoints.requests.list}?page=1&limit=10`, undefined, {
    auth: true,
  });
  if (state.requestId) {
    await runTest('Requests: get', 'Get request by id', 'GET', apiEndpoints.requests.get.replace(':id', state.requestId), undefined, {
      auth: true,
    });
    await runTest(
      'Requests: update',
      'Update request status',
      'PATCH',
      apiEndpoints.requests.update.replace(':id', state.requestId),
      { status: 'IN_PROGRESS' },
      { auth: true }
    );
    await runTest(
      'Requests: add message',
      'Add message to request',
      'POST',
      apiEndpoints.requests.addMessage.replace(':id', state.requestId),
      { message: 'Message from API tests' },
      { auth: true }
    );
    await runTest(
      'Requests: list messages',
      'List request messages',
      'GET',
      apiEndpoints.requests.listMessages.replace(':id', state.requestId) + '?page=1&limit=10',
      undefined,
      { auth: true }
    );
  }

  // Emergency
  const statusBefore = await runTest(
    'Emergency: status (before)',
    'Check current emergency status',
    'GET',
    apiEndpoints.emergency.status,
    undefined,
    { auth: true }
  );
  if (statusBefore.ok && statusBefore.data?.active && statusBefore.data.emergency?.id) {
    await runTest(
      'Emergency: clear existing',
      'Clear pre-existing emergency',
      'POST',
      apiEndpoints.emergency.clear.replace(':id', statusBefore.data.emergency.id),
      undefined,
      { auth: true }
    );
  }
  const trigger = await runTest(
    'Emergency: trigger',
    'Trigger emergency alert',
    'POST',
    apiEndpoints.emergency.trigger,
    { message: 'Test emergency message', severity: 'LOW' },
    { auth: true }
  );
  if (trigger.ok && trigger.data?.id) state.emergencyId = trigger.data.id;
  await runTest('Emergency: status (after)', 'Check emergency status after trigger', 'GET', apiEndpoints.emergency.status, undefined, {
    auth: true,
  });
  if (state.emergencyId) {
    await runTest(
      'Emergency: clear',
      'Clear triggered emergency',
      'POST',
      apiEndpoints.emergency.clear.replace(':id', state.emergencyId),
      undefined,
      { auth: true }
    );
  }
  await runTest(
    'Emergency: history',
    'List emergency history',
    'GET',
    apiEndpoints.emergency.history + '?page=1&limit=10',
    undefined,
    { auth: true }
  );

  // Notifications
  const notifList = await runTest(
    'Notifications: list',
    'List notifications',
    'GET',
    apiEndpoints.notifications.list + '?page=1&limit=10',
    undefined,
    { auth: true }
  );
  if (notifList.ok && Array.isArray(notifList.data?.items) && notifList.data.items.length > 0) {
    const nid = notifList.data.items[0].id;
    await runTest('Notifications: get', 'Get notification', 'GET', apiEndpoints.notifications.get.replace(':id', nid), undefined, {
      auth: true,
    });
    await runTest(
      'Notifications: mark read',
      'Mark notification read',
      'POST',
      apiEndpoints.notifications.markRead.replace(':id', nid),
      undefined,
      { auth: true }
    );
  }
  await runTest(
    'Notifications: mark all read',
    'Mark all notifications as read',
    'POST',
    apiEndpoints.notifications.markAllRead,
    undefined,
    { auth: true }
  );

  // Audit logs
  await runTest(
    'Audit logs: list',
    'List audit logs',
    'GET',
    apiEndpoints.auditLogs.list + '?page=1&limit=10',
    undefined,
    { auth: true }
  );

  // API keys
  const apiKeyCreate = await runTest(
    'API Keys: create',
    'Create API key',
    'POST',
    apiEndpoints.apiKeys.create,
    { name: 'QA Key' },
    { auth: true }
  );
  let apiKeyId: string | undefined;
  if (apiKeyCreate.ok && apiKeyCreate.data?.id) apiKeyId = apiKeyCreate.data.id;
  await runTest('API Keys: list', 'List API keys', 'GET', apiEndpoints.apiKeys.list, undefined, { auth: true });
  if (apiKeyId) {
    await runTest(
      'API Keys: rotate',
      'Rotate API key',
      'POST',
      apiEndpoints.apiKeys.rotate.replace(':id', apiKeyId),
      undefined,
      { auth: true }
    );
    await runTest(
      'API Keys: revoke',
      'Revoke API key',
      'POST',
      apiEndpoints.apiKeys.revoke.replace(':id', apiKeyId),
      undefined,
      { auth: true }
    );
  }

  // Webhooks
  const webhookCreate = await runTest(
    'Webhooks: create',
    'Create webhook',
    'POST',
    apiEndpoints.webhooks.create,
    { name: 'QA Webhook', event_types: ['test'], target_url: 'https://example.com/hook' },
    { auth: true }
  );
  let webhookId: string | undefined;
  if (webhookCreate.ok && webhookCreate.data?.id) webhookId = webhookCreate.data.id;
  await runTest('Webhooks: list', 'List webhooks', 'GET', apiEndpoints.webhooks.list, undefined, { auth: true });
  if (webhookId) {
    await runTest(
      'Webhooks: update',
      'Update webhook',
      'PATCH',
      apiEndpoints.webhooks.update.replace(':id', webhookId),
      { is_active: false },
      { auth: true }
    );
    await runTest('Webhooks: test', 'Test webhook', 'POST', apiEndpoints.webhooks.test.replace(':id', webhookId), undefined, {
      auth: true,
    });
    await runTest(
      'Webhooks: delete',
      'Delete webhook',
      'DELETE',
      apiEndpoints.webhooks.delete.replace(':id', webhookId),
      undefined,
      { auth: true }
    );
  }

  // SSO config
  const ssoUpsert = await runTest(
    'SSO: upsert',
    'Upsert SSO config',
    'POST',
    apiEndpoints.ssoConfig.upsert,
    {
      provider: 'oidc',
      issuer: 'https://example.com',
      client_id: 'client',
      client_secret: 'secret',
      redirect_uri: 'https://example.com/redirect',
    },
    { auth: true }
  );
  await runTest('SSO: list', 'List SSO config', 'GET', apiEndpoints.ssoConfig.list, undefined, { auth: true });
  if (ssoUpsert.ok && ssoUpsert.data?.id) {
    await runTest(
      'SSO: deactivate',
      'Deactivate SSO config',
      'POST',
      apiEndpoints.ssoConfig.deactivate.replace(':id', ssoUpsert.data.id),
      undefined,
      { auth: true }
    );
  }

  // Settings
  await runTest('Settings: list', 'List settings', 'GET', apiEndpoints.settings.list, undefined, { auth: true });
  await runTest('Settings: upsert', 'Upsert setting', 'POST', apiEndpoints.settings.upsert, { key: 'qa_test', value: 'on' }, { auth: true });

  // Conversations
  const convoStart = await runTest(
    'Conversations: start',
    'Start conversation',
    'POST',
    apiEndpoints.conversations.start,
    { participant_id: state.userId || randomUUID() },
    { auth: true }
  );
  const convoId = convoStart.data?.id;
  await runTest('Conversations: list', 'List conversations', 'GET', apiEndpoints.conversations.list, undefined, { auth: true });
  if (convoId) {
    await runTest(
      'Conversations: send message',
      'Send conversation message',
      'POST',
      apiEndpoints.conversations.sendMessage.replace(':id', convoId),
      { content: 'Hello from tests' },
      { auth: true }
    );
    await runTest(
      'Conversations: list messages',
      'List conversation messages',
      'GET',
      apiEndpoints.conversations.listMessages.replace(':id', convoId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Conversations: mark read',
      'Mark conversation read',
      'POST',
      apiEndpoints.conversations.markRead.replace(':id', convoId),
      undefined,
      { auth: true }
    );
  }

  // Proof of Play
  await runTest('Proof of play: list', 'List proof-of-play records', 'GET', apiEndpoints.proofOfPlay.list + '?page=1&limit=10', undefined, {
    auth: true,
  });
  await runTest('Proof of play: export', 'Export proof-of-play', 'GET', apiEndpoints.proofOfPlay.export, undefined, { auth: true });

  // Metrics
  await runTest('Metrics: overview', 'Metrics overview', 'GET', apiEndpoints.metrics.overview, undefined, { auth: true });

  // Reports
  await runTest('Reports: summary', 'Reports summary', 'GET', apiEndpoints.reports.summary, undefined, { auth: true });
  await runTest('Reports: trends', 'Reports trends', 'GET', apiEndpoints.reports.trends, undefined, { auth: true });

  // Device pairing
  const pairing = await runTest(
    'Device pairing: generate',
    'Generate device pairing code',
    'POST',
    apiEndpoints.devicePairing.generate,
    { device_id: state.screenId || randomUUID(), expires_in: 600 },
    { auth: true }
  );
  if (pairing.ok && pairing.data?.pairing_code) state.pairingCode = pairing.data.pairing_code;
  await runTest(
    'Device pairing: list',
    'List device pairings',
    'GET',
    `${apiEndpoints.devicePairing.list}?page=1&limit=10`,
    undefined,
    { auth: true }
  );

  // Device telemetry
  if (state.screenId && bucketsReady) {
    await runTest(
      'Device heartbeat',
      'Post heartbeat for device',
      'POST',
      apiEndpoints.deviceTelemetry.heartbeat,
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
      apiEndpoints.deviceTelemetry.proofOfPlay,
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
      apiEndpoints.deviceTelemetry.screenshot,
      { device_id: state.screenId, timestamp: new Date().toISOString(), image_data: Buffer.from('hello').toString('base64') }
    );
    await runTest(
      'Device commands',
      'Fetch pending device commands',
      'GET',
      apiEndpoints.deviceTelemetry.commands.replace(':deviceId', state.screenId)
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

  // Logout
  await runTest('Auth: logout', 'Logout user', 'POST', apiEndpoints.auth.logout, undefined, { auth: true });

  writeReport();
}

function writeReport() {
  mkdirSync(reportDir, { recursive: true });

  const passed = results.filter((r) => r.success).length;
  const failed = results.length - passed;

  const summaryLines = results
    .map((r) => `| ${r.name} | ${r.method} | ${r.endpoint} | ${r.status ?? 'ERR'} | ${r.success ? '✅' : '❌'} | ${r.note || ''} |`)
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
