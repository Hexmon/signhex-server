import 'dotenv/config';
import { performance } from 'perf_hooks';
import { access } from 'fs/promises';
import { initializeDatabase, getDatabase, closeDatabase, schema } from '../src/db/index.js';
import { eq } from 'drizzle-orm';

type HttpResult = {
  ok: boolean;
  status: number | null;
  data?: any;
  duration?: number;
  error?: string;
};

export type PairingScenarioResult = {
  scenario: string;
  expectedStatus: number;
  actualStatus: number | null;
  traceId?: string | null;
  responsePreview?: string;
  note?: string;
  deviceId?: string | null;
  pairingCode?: string | null;
  pairingUsed?: boolean | null;
  certificateCreated?: boolean | null;
};

const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const caCertPath = process.env.CA_CERT_PATH || './certs/ca.crt';

function summarizeResponse(data: any) {
  if (!data) return '';
  try {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    return raw.length > 240 ? `${raw.slice(0, 240)}...` : raw;
  } catch {
    return '';
  }
}

async function httpRequest(
  method: string,
  endpoint: string,
  body?: any
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const started = performance.now();
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
  }
}

async function checkFile(pathValue: string) {
  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
}

function buildDummyCsr(deviceId: string, mode: 'pem' | 'no-header' | 'base64'): string {
  const content = Buffer.from(`CN=${deviceId};${Date.now()}`).toString('base64');
  if (mode === 'no-header') return content;
  if (mode === 'base64') return content;
  return `-----BEGIN CERTIFICATE REQUEST-----\n${content}\n-----END CERTIFICATE REQUEST-----`;
}

async function inspectPairing(pairingCode: string) {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(schema.devicePairings)
    .where(eq(schema.devicePairings.pairing_code, pairingCode));
  return rows[0] || null;
}

async function inspectCertificates(deviceId: string) {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(schema.deviceCertificates)
    .where(eq(schema.deviceCertificates.screen_id, deviceId));
  return rows;
}

async function requestPairing() {
  const payload = {
    device_label: `Repro ${Date.now()}`,
    expires_in: 600,
    width: 1920,
    height: 1080,
    aspect_ratio: '16:9',
    orientation: 'landscape',
    model: 'ReproDevice',
  };
  const res = await httpRequest('POST', '/api/v1/device-pairing/request', payload);
  if (!res.ok) {
    throw new Error(`Pairing request failed: ${res.status} ${summarizeResponse(res.data)}`);
  }
  return res.data;
}

export async function runReproDevicePairingComplete(): Promise<PairingScenarioResult[]> {
  const results: PairingScenarioResult[] = [];

  const caExists = await checkFile(caCertPath);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`CA_CERT_PATH: ${caCertPath} (exists=${caExists})`);

  await initializeDatabase();

  const scenarios = [
    {
      name: 'valid',
      expected: 201,
      buildPayload: (code: string, deviceId: string) => ({
        pairing_code: code,
        csr: buildDummyCsr(deviceId, 'pem'),
      }),
    },
    {
      name: 'pairingCode (camelCase)',
      expected: 422,
      buildPayload: (code: string, deviceId: string) => ({
        pairingCode: code,
        csr: buildDummyCsr(deviceId, 'pem'),
      }),
    },
    {
      name: 'csr missing header/footer',
      expected: 400,
      buildPayload: (code: string, deviceId: string) => ({
        pairing_code: code,
        csr: buildDummyCsr(deviceId, 'no-header'),
      }),
    },
    {
      name: 'csr base64 only',
      expected: 400,
      buildPayload: (code: string, deviceId: string) => ({
        pairing_code: code,
        csr: buildDummyCsr(deviceId, 'base64'),
      }),
    },
    {
      name: 'wrong pairing_code',
      expected: 404,
      buildPayload: (_code: string, deviceId: string) => ({
        pairing_code: '000000',
        csr: buildDummyCsr(deviceId, 'pem'),
      }),
    },
  ];

  for (const scenario of scenarios) {
    const pairing = await requestPairing();
    const pairingCode = pairing?.pairing_code as string;
    const deviceId = pairing?.device_id as string;

    const beforeRow = await inspectPairing(pairingCode);
    const payload = scenario.buildPayload(pairingCode, deviceId);
    const res = await httpRequest('POST', '/api/v1/device-pairing/complete', payload);
    const afterRow = await inspectPairing(pairingCode);
    const certRows = await inspectCertificates(deviceId);

    const traceId = res.data?.error?.traceId ?? res.data?.traceId ?? null;
    results.push({
      scenario: scenario.name,
      expectedStatus: scenario.expected,
      actualStatus: res.status,
      traceId,
      responsePreview: summarizeResponse(res.data),
      note: res.error,
      deviceId,
      pairingCode,
      pairingUsed: afterRow?.used ?? beforeRow?.used ?? null,
      certificateCreated: certRows.length > 0,
    });

    console.log(
      `[${scenario.name}] status=${res.status} expected=${scenario.expected} traceId=${traceId ?? 'n/a'}`
    );
  }

  await closeDatabase();
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReproDevicePairingComplete()
    .then(() => {
      console.log('Repro complete');
    })
    .catch((err) => {
      console.error('Repro failed', err);
      process.exitCode = 1;
    });
}
