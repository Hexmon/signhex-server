import 'dotenv/config';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { initializeS3, createBucketIfNotExists } from '../src/s3/index.js';
import { apiEndpoints } from '../src/config/apiEndpoints.js';
import { runReproDevicePairingComplete, PairingScenarioResult } from './repro-device-pairing-complete.js';

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

type RunTestOptions = {
  auth?: boolean;
  note?: string;
  expectStatus?: number | number[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const reportDir = path.join(projectRoot, 'reports');
const reportPath = path.join(reportDir, 'api-test-report.md');

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const adminEmail = getRequiredEnv('ADMIN_EMAIL');
const adminPassword = getRequiredEnv('ADMIN_PASSWORD');

const results: TestResult[] = [];
const state: Record<string, string> = {};
let bearerToken: string | null = null;
let bucketsReady = false;
let reproResults: PairingScenarioResult[] = [];

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
  opts: RunTestOptions = {}
): Promise<HttpResult> {
  const started = performance.now();
  const response = await httpRequest(method, endpoint, { body, auth: opts.auth });
  const duration = performance.now() - started;

  const expected = opts.expectStatus;
  const expectedStatuses = Array.isArray(expected) ? expected : expected ? [expected] : null;
  const success = expectedStatuses ? expectedStatuses.includes(response.status ?? -1) : response.ok;

  const sanitizedResponse = response.data ? sanitize(response.data) : undefined;
  const entry: TestResult = {
    name,
    purpose,
    method,
    endpoint,
    status: response.status,
    success,
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
  await runTest('Health', 'Check API health', 'GET', '/api/v1/health');

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

  // Roles (for role_id mapping)
  const rolesRes = await runTest(
    'Roles: list',
    'List roles for role_id lookup',
    'GET',
    `${apiEndpoints.roles.list}?page=1&limit=100`,
    undefined,
    { auth: true }
  );
  if (rolesRes.ok && rolesRes.data?.items) {
    for (const role of rolesRes.data.items) {
      if (role?.name && role?.id) {
        state[`role_${role.name}`] = role.id;
      }
    }
  }

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
  await runTest('Users: invites list', 'List user invites', 'GET', `${apiEndpoints.userInvite.list}?page=1&limit=10`, undefined, {
    auth: true,
  });
  await runTest('Users: invites pending', 'List pending user invites', 'GET', apiEndpoints.userInvite.pending, undefined, {
    auth: true,
  });

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
  const operatorRoleId = state.role_OPERATOR;
  const userPayload = {
    email: `qa+${Date.now()}@hexmon.local`,
    password: 'TestPass123!',
    first_name: 'QA',
    last_name: 'User',
    role_id: operatorRoleId,
  };
  const userCreate = await runTest('Users: create', 'Create user', 'POST', apiEndpoints.users.create, userPayload, {
    auth: true,
    note: operatorRoleId ? undefined : 'Missing OPERATOR role_id from /api/v1/roles',
  });
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
    await runTest(
      'Users: reset password',
      'Reset user password',
      'POST',
      apiEndpoints.userInvite.resetPassword.replace(':id', state.userId),
      { current_password: userPayload.password, new_password: 'NewPass123!X' },
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
  const mediaMetaCreate = await runTest(
    'Media: create metadata',
    'Create media metadata entry',
    'POST',
    apiEndpoints.media.create,
    { name: 'Test Media', type: 'IMAGE' },
    { auth: true }
  );
  if (mediaMetaCreate.ok && mediaMetaCreate.data?.id) state.mediaMetaId = mediaMetaCreate.data.id;
  await runTest('Media: list', 'List media', 'GET', `${apiEndpoints.media.list}?page=1&limit=10`, undefined, { auth: true });
  const mediaToGet = state.mediaId || state.mediaMetaId;
  if (mediaToGet) {
    await runTest(
      'Media: get',
      'Get media by id',
      'GET',
      apiEndpoints.media.get.replace(':id', mediaToGet),
      undefined,
      { auth: true }
    );
  }

  // Layouts
  const layoutPayload = {
    name: `QA Layout ${Date.now()}`,
    description: 'Created by api-test-report',
    aspect_ratio: '16:9',
    spec: { slots: [{ id: 'main', x: 0, y: 0, w: 1, h: 1 }] },
  };
  const layoutCreate = await runTest('Layouts: create', 'Create layout', 'POST', apiEndpoints.layouts.create, layoutPayload, {
    auth: true,
  });
  if (layoutCreate.ok && layoutCreate.data?.id) state.layoutId = layoutCreate.data.id;
  await runTest('Layouts: list', 'List layouts', 'GET', `${apiEndpoints.layouts.list}?page=1&limit=10`, undefined, { auth: true });
  if (state.layoutId) {
    await runTest(
      'Layouts: get',
      'Get layout',
      'GET',
      apiEndpoints.layouts.get.replace(':id', state.layoutId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Layouts: update',
      'Update layout description',
      'PATCH',
      apiEndpoints.layouts.update.replace(':id', state.layoutId),
      { description: 'Updated via API tests' },
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
  const presentationPayload = {
    name: `QA Presentation ${Date.now()}`,
    description: 'Created by tests',
    ...(state.layoutId ? { layout_id: state.layoutId } : {}),
  };
  const presentationCreate = await runTest(
    'Presentations: create',
    'Create presentation',
    'POST',
    apiEndpoints.presentations.create,
    presentationPayload,
    { auth: true }
  );
  if (presentationCreate.ok && presentationCreate.data?.id) state.presentationId = presentationCreate.data.id;
  const mediaForPresentation = state.mediaId || state.mediaMetaId;
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
    if (mediaForPresentation) {
      const addItemRes = await runTest(
        'Presentations: add item',
        'Add media to presentation',
        'POST',
        apiEndpoints.presentations.items.replace(':id', state.presentationId),
        { media_id: mediaForPresentation, order: 0, duration_seconds: 15 },
        { auth: true }
      );
      if (addItemRes.ok && addItemRes.data?.id) state.presentationItemId = addItemRes.data.id;
      await runTest(
        'Presentations: list items',
        'List presentation items',
        'GET',
        apiEndpoints.presentations.items.replace(':id', state.presentationId),
        undefined,
        { auth: true }
      );
      if (state.presentationItemId) {
        await runTest(
          'Presentations: delete item',
          'Delete presentation item',
          'DELETE',
          apiEndpoints.presentations.item
            .replace(':id', state.presentationId)
            .replace(':itemId', state.presentationItemId),
          undefined,
          { auth: true }
        );
      }
    }
    if (mediaForPresentation && state.layoutId) {
      const addSlotRes = await runTest(
        'Presentations: add slot item',
        'Add media to presentation slot',
        'POST',
        apiEndpoints.presentations.slotItems.replace(':id', state.presentationId),
        { slot_id: 'main', media_id: mediaForPresentation, order: 0, duration_seconds: 15 },
        { auth: true }
      );
      if (addSlotRes.ok && addSlotRes.data?.id) state.presentationSlotItemId = addSlotRes.data.id;
      await runTest(
        'Presentations: list slot items',
        'List presentation slot items',
        'GET',
        apiEndpoints.presentations.slotItems.replace(':id', state.presentationId),
        undefined,
        { auth: true }
      );
      if (state.presentationSlotItemId) {
        await runTest(
          'Presentations: delete slot item',
          'Delete presentation slot item',
          'DELETE',
          apiEndpoints.presentations.slotItem
            .replace(':id', state.presentationId)
            .replace(':slotItemId', state.presentationSlotItemId),
          undefined,
          { auth: true }
        );
      }
    }
  }

  // Schedules
  const startAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const endAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const itemStartAt = new Date(new Date(startAt).getTime() + 5 * 60 * 1000).toISOString();
  const itemEndAt = new Date(new Date(startAt).getTime() + 30 * 60 * 1000).toISOString();
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
    if (state.presentationId) {
      const addScheduleItem = await runTest(
        'Schedules: add item',
        'Add schedule item',
        'POST',
        apiEndpoints.schedules.items.replace(':id', state.scheduleId),
        {
          presentation_id: state.presentationId,
          start_at: itemStartAt,
          end_at: itemEndAt,
          priority: 0,
          screen_ids: state.screenId ? [state.screenId] : [],
          screen_group_ids: [],
        },
        { auth: true }
      );
      if (addScheduleItem.ok && addScheduleItem.data?.id) state.scheduleItemId = addScheduleItem.data.id;
      await runTest(
        'Schedules: list items',
        'List schedule items',
        'GET',
        apiEndpoints.schedules.items.replace(':id', state.scheduleId),
        undefined,
        { auth: true }
      );
    }
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
        const publishStatus = await runTest(
          'Publishes: get',
          'Get publish record',
          'GET',
          apiEndpoints.schedules.publishStatus.replace(':id', state.publishId),
          undefined,
          { auth: true }
        );
        if (publishStatus.ok && publishStatus.data?.targets?.length) {
          const targetId = publishStatus.data.targets[0].id;
          await runTest(
            'Publishes: update target',
            'Update publish target status',
            'PATCH',
            apiEndpoints.schedules.updatePublishTarget
              .replace(':publishId', state.publishId)
              .replace(':targetId', targetId),
            { status: 'ACKNOWLEDGED' },
            { auth: true }
          );
        }
      }
    }
  }

  // Schedule requests
  if (state.scheduleId) {
    const scheduleRequestPayload = {
      schedule_id: state.scheduleId,
      payload: {
        screen_ids: state.screenId ? [state.screenId] : [],
        screen_group_ids: [],
        notes: 'QA schedule request',
      },
      notes: 'Please approve this schedule',
    };
    const scheduleRequestCreate = await runTest(
      'Schedule requests: create',
      'Create schedule request',
      'POST',
      apiEndpoints.scheduleRequests.create,
      scheduleRequestPayload,
      { auth: true }
    );
    if (scheduleRequestCreate.ok && scheduleRequestCreate.data?.id) state.scheduleRequestId = scheduleRequestCreate.data.id;
    await runTest(
      'Schedule requests: list',
      'List schedule requests',
      'GET',
      `${apiEndpoints.scheduleRequests.list}?page=1&limit=10`,
      undefined,
      { auth: true }
    );
    if (state.scheduleRequestId) {
      await runTest(
        'Schedule requests: get',
        'Get schedule request',
        'GET',
        apiEndpoints.scheduleRequests.get.replace(':id', state.scheduleRequestId),
        undefined,
        { auth: true }
      );
      await runTest(
        'Schedule requests: update',
        'Update schedule request notes',
        'PATCH',
        apiEndpoints.scheduleRequests.update.replace(':id', state.scheduleRequestId),
        { notes: 'Updated request notes' },
        { auth: true }
      );
      await runTest(
        'Schedule requests: approve',
        'Approve schedule request',
        'POST',
        apiEndpoints.scheduleRequests.approve.replace(':id', state.scheduleRequestId),
        { comment: 'Approved in API tests' },
        { auth: true }
      );
      await runTest(
        'Schedule requests: publish',
        'Publish schedule request',
        'POST',
        apiEndpoints.scheduleRequests.publish.replace(':id', state.scheduleRequestId),
        undefined,
        { auth: true }
      );
    }
    const scheduleRejectCreate = await runTest(
      'Schedule requests: create (reject)',
      'Create schedule request to reject',
      'POST',
      apiEndpoints.scheduleRequests.create,
      scheduleRequestPayload,
      { auth: true }
    );
    if (scheduleRejectCreate.ok && scheduleRejectCreate.data?.id) {
      await runTest(
        'Schedule requests: reject',
        'Reject schedule request',
        'POST',
        apiEndpoints.scheduleRequests.reject.replace(':id', scheduleRejectCreate.data.id),
        { comment: 'Rejected in API tests' },
        { auth: true }
      );
    }
  }

  // Screens (extended)
  await runTest('Screens: overview', 'Overview of screens and groups', 'GET', apiEndpoints.screens.overview, undefined, {
    auth: true,
  });
  if (state.screenId) {
    await runTest(
      'Screens: status',
      'Get screen status',
      'GET',
      apiEndpoints.screens.status.replace(':id', state.screenId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Screens: heartbeats',
      'List screen heartbeats',
      'GET',
      `${apiEndpoints.screens.heartbeats.replace(':id', state.screenId)}?page=1&limit=10`,
      undefined,
      { auth: true }
    );
    await runTest(
      'Screens: screenshot settings',
      'Set screen screenshot interval',
      'POST',
      apiEndpoints.screens.screenshotSettings.replace(':id', state.screenId),
      { interval_seconds: 600, enabled: true },
      { auth: true }
    );
    await runTest(
      'Screens: screenshot trigger',
      'Trigger screen screenshot',
      'POST',
      apiEndpoints.screens.screenshot.replace(':id', state.screenId),
      { reason: 'API test' },
      { auth: true }
    );
    await runTest(
      'Screens: now playing',
      'Get screen now playing',
      'GET',
      apiEndpoints.screens.nowPlaying.replace(':id', state.screenId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Screens: availability',
      'Get screen availability',
      'GET',
      apiEndpoints.screens.availability.replace(':id', state.screenId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Screens: snapshot',
      'Get screen snapshot',
      'GET',
      apiEndpoints.screens.snapshot.replace(':id', state.screenId),
      undefined,
      { auth: true }
    );
  }

  // Screen groups
  const screenGroupPayload = {
    name: `QA Screen Group ${Date.now()}`,
    description: 'Created by api-test-report',
    screen_ids: state.screenId ? [state.screenId] : [],
  };
  const screenGroupCreate = await runTest(
    'Screen groups: create',
    'Create screen group',
    'POST',
    apiEndpoints.screenGroups.create,
    screenGroupPayload,
    { auth: true }
  );
  if (screenGroupCreate.ok && screenGroupCreate.data?.id) state.screenGroupId = screenGroupCreate.data.id;
  await runTest(
    'Screen groups: list',
    'List screen groups',
    'GET',
    `${apiEndpoints.screenGroups.list}?page=1&limit=10`,
    undefined,
    { auth: true }
  );
  if (state.screenGroupId) {
    await runTest(
      'Screen groups: get',
      'Get screen group',
      'GET',
      apiEndpoints.screenGroups.get.replace(':id', state.screenGroupId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Screen groups: update',
      'Update screen group',
      'PATCH',
      apiEndpoints.screenGroups.update.replace(':id', state.screenGroupId),
      { description: 'Updated via API tests' },
      { auth: true }
    );
    await runTest(
      'Screen groups: available screens',
      'List available screens for groups',
      'GET',
      `${apiEndpoints.screenGroups.availableScreens}?page=1&limit=10&group_id=${state.screenGroupId}`,
      undefined,
      { auth: true }
    );
    await runTest(
      'Screen groups: availability',
      'Get group availability',
      'GET',
      apiEndpoints.screenGroups.availability.replace(':id', state.screenGroupId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Screen groups: now playing',
      'Get group now playing',
      'GET',
      apiEndpoints.screenGroupNowPlaying.get.replace(':id', state.screenGroupId),
      undefined,
      { auth: true }
    );
    await runTest(
      'Screen groups: screenshot settings',
      'Set group screenshot interval',
      'POST',
      apiEndpoints.screenGroups.screenshotSettings.replace(':id', state.screenGroupId),
      { interval_seconds: 600, enabled: true },
      { auth: true }
    );
    await runTest(
      'Screen groups: screenshot trigger',
      'Trigger group screenshot',
      'POST',
      apiEndpoints.screenGroups.screenshot.replace(':id', state.screenGroupId),
      { reason: 'API test' },
      { auth: true }
    );
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
    await runTest(
      'Notifications: delete',
      'Delete notification',
      'DELETE',
      apiEndpoints.notifications.delete.replace(':id', nid),
      undefined,
      { auth: true }
    );
  } else {
    await runTest(
      'Notifications: delete (missing)',
      'Delete non-existent notification',
      'DELETE',
      apiEndpoints.notifications.delete.replace(':id', randomUUID()),
      undefined,
      { auth: true, expectStatus: 404 }
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
  const auditList = await runTest(
    'Audit logs: list',
    'List audit logs',
    'GET',
    apiEndpoints.auditLogs.list + '?page=1&limit=10',
    undefined,
    { auth: true }
  );
  if (auditList.ok && Array.isArray(auditList.data?.items) && auditList.data.items.length > 0) {
    const auditId = auditList.data.items[0].id;
    await runTest(
      'Audit logs: get',
      'Get audit log',
      'GET',
      apiEndpoints.auditLogs.get.replace(':id', auditId),
      undefined,
      { auth: true }
    );
  } else {
    await runTest(
      'Audit logs: get (missing)',
      'Get non-existent audit log',
      'GET',
      apiEndpoints.auditLogs.get.replace(':id', randomUUID()),
      undefined,
      { auth: true, expectStatus: 404 }
    );
  }

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
  await runTest(
    'Reports: requests by department',
    'Requests grouped by department',
    'GET',
    apiEndpoints.reports.requestsByDepartment,
    undefined,
    { auth: true }
  );
  await runTest('Reports: offline screens', 'Offline screens report', 'GET', apiEndpoints.reports.offlineScreens, undefined, {
    auth: true,
  });
  await runTest('Reports: storage', 'Storage report', 'GET', apiEndpoints.reports.storage, undefined, { auth: true });
  await runTest('Reports: system health', 'System health report', 'GET', apiEndpoints.reports.systemHealth, undefined, {
    auth: true,
  });

  // Device pairing
  const requestPairing = await runTest(
    'Device pairing: request',
    'Device-initiated pairing request',
    'POST',
    apiEndpoints.devicePairing.request,
    { device_label: 'QA Device', expires_in: 600 }
  );
  if (requestPairing.ok && requestPairing.data?.pairing_code) {
    await runTest(
      'Device pairing: confirm',
      'Confirm pairing and create screen',
      'POST',
      apiEndpoints.devicePairing.confirm,
      { pairing_code: requestPairing.data.pairing_code, name: 'QA Paired Screen', location: 'QA Lab' },
      { auth: true }
    );
  }
  const pairing = await runTest(
    'Device pairing: generate',
    'Generate device pairing code',
    'POST',
    apiEndpoints.devicePairing.generate,
    { device_id: state.screenId || randomUUID(), expires_in: 600 },
    { auth: true }
  );
  if (pairing.ok && pairing.data?.pairing_code) state.pairingCode = pairing.data.pairing_code;
  if (state.pairingCode) {
    await runTest(
      'Device pairing: complete',
      'Complete device pairing with CSR',
      'POST',
      apiEndpoints.devicePairing.complete,
      {
        pairing_code: state.pairingCode,
        csr: '-----BEGIN CERTIFICATE REQUEST-----\nTESTCSR\n-----END CERTIFICATE REQUEST-----',
      }
    );
  }
  await runTest(
    'Device pairing: list',
    'List device pairings',
    'GET',
    `${apiEndpoints.devicePairing.list}?page=1&limit=10`,
    undefined,
    { auth: true }
  );

  try {
    reproResults = await runReproDevicePairingComplete();
  } catch (error: any) {
    reproResults = [
      {
        scenario: 'repro-runner',
        expectedStatus: 201,
        actualStatus: null,
        note: error?.message || String(error),
      },
    ];
  }

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
    const commandsRes = await runTest(
      'Device commands',
      'Fetch pending device commands',
      'GET',
      apiEndpoints.deviceTelemetry.commands.replace(':deviceId', state.screenId)
    );
    if (commandsRes.ok && Array.isArray(commandsRes.data?.commands) && commandsRes.data.commands.length > 0) {
      const commandId = commandsRes.data.commands[0].id;
      await runTest(
        'Device command ack',
        'Acknowledge device command',
        'POST',
        apiEndpoints.deviceTelemetry.ackCommand.replace(':deviceId', state.screenId).replace(':commandId', commandId)
      );
    } else {
      await runTest(
        'Device command ack (missing)',
        'Acknowledge non-existent command',
        'POST',
        apiEndpoints.deviceTelemetry.ackCommand.replace(':deviceId', state.screenId).replace(':commandId', randomUUID()),
        undefined,
        { expectStatus: 404 }
      );
    }
    await runTest(
      'Device snapshot',
      'Fetch device snapshot',
      'GET',
      apiEndpoints.deviceTelemetry.snapshot.replace(':deviceId', state.screenId),
      undefined,
      { auth: true }
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

  // Cleanup delete endpoints
  if (state.scheduleId && state.scheduleItemId) {
    await runTest(
      'Schedules: delete item',
      'Delete schedule item',
      'DELETE',
      apiEndpoints.schedules.item.replace(':id', state.scheduleId).replace(':itemId', state.scheduleItemId),
      undefined,
      { auth: true }
    );
  }
  if (state.presentationId) {
    await runTest(
      'Presentations: delete',
      'Delete presentation',
      'DELETE',
      apiEndpoints.presentations.delete.replace(':id', state.presentationId),
      undefined,
      { auth: true }
    );
  }
  if (state.layoutId) {
    await runTest(
      'Layouts: delete',
      'Delete layout',
      'DELETE',
      apiEndpoints.layouts.delete.replace(':id', state.layoutId),
      undefined,
      { auth: true, expectStatus: 404 }
    );
  }
  const mediaToDelete = state.mediaId || state.mediaMetaId;
  if (mediaToDelete) {
    await runTest(
      'Media: delete',
      'Delete media',
      'DELETE',
      apiEndpoints.media.delete.replace(':id', mediaToDelete),
      undefined,
      { auth: true }
    );
  }
  if (state.screenGroupId) {
    await runTest(
      'Screen groups: delete',
      'Delete screen group',
      'DELETE',
      apiEndpoints.screenGroups.delete.replace(':id', state.screenGroupId),
      undefined,
      { auth: true }
    );
  }
  if (state.screenId) {
    await runTest(
      'Screens: delete',
      'Delete screen',
      'DELETE',
      apiEndpoints.screens.delete.replace(':id', state.screenId),
      undefined,
      { auth: true }
    );
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

  const commit = (() => {
    try {
      return execSync('git rev-parse --short HEAD', { cwd: projectRoot }).toString().trim();
    } catch {
      return null;
    }
  })();

  const dbSummary = (() => {
    if (!process.env.DATABASE_URL) return null;
    try {
      const url = new URL(process.env.DATABASE_URL);
      return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
    } catch {
      return null;
    }
  })();

  const migrationsDir = path.join(projectRoot, 'drizzle');
  const migrationsPresent = existsSync(migrationsDir) && readdirSync(migrationsDir).length > 0;

  const reproTable = reproResults.length
    ? reproResults
        .map((r) => {
          const status = r.actualStatus ?? 'ERR';
          const ok = r.actualStatus === r.expectedStatus;
          return `| ${r.scenario} | ${r.expectedStatus} | ${status} | ${ok ? '✅' : '❌'} | ${r.traceId ?? ''} | ${r.responsePreview ?? ''} |`;
        })
        .join('\n')
    : 'No repro data collected.';

  const reproCause = (() => {
    const cause = reproResults.find((r) => r.responsePreview?.includes('CA_CERT_MISSING'));
    if (cause) {
      return 'Server missing CA certificate (CA_CERT_PATH) or file not found.';
    }
    const internal = reproResults.find((r) => r.actualStatus === 500);
    if (internal) {
      return 'Server returned 500 during pairing complete. Check server logs for traceId.';
    }
    return 'No server-side error detected in pairing complete repro.';
  })();

  const reproFix = (() => {
    if (reproCause.includes('CA certificate')) {
      return 'Place the CA certificate at CA_CERT_PATH or update CA_CERT_PATH to the correct file.';
    }
    if (reproCause.includes('500')) {
      return 'Inspect server logs for the traceId; fix underlying server error or improve input validation.';
    }
    return 'No fix required.';
  })();

  const markdown = `# API Test Report

- Timestamp: ${new Date().toISOString()}
- Base URL: ${baseUrl}
- Auth user: ${adminEmail}
- Server commit: ${commit ?? 'n/a'}
- DB: ${dbSummary ?? 'n/a'}
- Migrations present: ${migrationsPresent ? 'yes' : 'no'}
- Total: ${results.length}, Passed: ${passed}, Failed: ${failed}

## Repro: Device Pairing Complete

### Curl commands
\`\`\`bash
curl -X POST "${baseUrl}/api/v1/device-pairing/request" \\
  -H "Content-Type: application/json" \\
  -d '{"device_label":"Repro Device","expires_in":600}'

curl -X POST "${baseUrl}/api/v1/device-pairing/complete" \\
  -H "Content-Type: application/json" \\
  -d '{"pairing_code":"<PAIRING_CODE>","csr":"-----BEGIN CERTIFICATE REQUEST-----\\n<CSR>\\n-----END CERTIFICATE REQUEST-----"}'
\`\`\`

### Results
| Scenario | Expected | Actual | Result | TraceId | Preview |
| --- | --- | --- | --- | --- | --- |
${reproTable}

### Root cause conclusion
- ${reproCause}
- Recommended fix: ${reproFix}

## Test Summary

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
