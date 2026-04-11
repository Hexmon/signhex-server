import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  getObservabilityRegistry,
  observeJobProcessing,
  observeS3Operation,
  recordDeviceAuthAttempt,
  recordDeviceCommandClaim,
  recordJobEnqueue,
  recordPairingCodeAllocation,
  recordPairingCsrValidation,
  recordTelemetryIngest,
  resetObservabilityMetricsForTests,
} from '@/observability/metrics';
import { closeTestServer, createTestServer } from '@/test/helpers';

describe('backend observability instrumentation', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
  });

  beforeEach(() => {
    resetObservabilityMetricsForTests();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('records custom telemetry, job, and S3 metrics in the shared registry', async () => {
    recordJobEnqueue('telemetry:heartbeat', 'success');
    recordTelemetryIngest({
      telemetryType: 'heartbeat',
      persistMode: 'queue',
      result: 'success',
      heartbeatStatus: 'ONLINE',
      durationSeconds: 0.01,
    });
    await observeJobProcessing('telemetry:heartbeat', async () => undefined);
    await observeS3Operation('put_object', async () => ({ ok: true }));

    const output = await getObservabilityRegistry().metrics();

    expect(output).toContain('signhex_server_job_enqueued_total{queue="telemetry:heartbeat",result="success"} 1');
    expect(output).toContain('signhex_server_device_telemetry_ingest_total{telemetry_type="heartbeat",result="success",persist_mode="queue"} 1');
    expect(output).toContain('signhex_server_device_heartbeats_received_total{status="ONLINE",result="success",persist_mode="queue"} 1');
    expect(output).toContain('signhex_server_job_processing_total{queue="telemetry:heartbeat",result="success"} 1');
    expect(output).toContain('signhex_server_s3_operations_total{operation="put_object",result="success"} 1');
  });

  it('records runtime hardening metrics for pairing, auth, and command claim paths', async () => {
    recordPairingCodeAllocation('device_request', 'collision_retry');
    recordPairingCodeAllocation('device_request', 'success');
    recordPairingCsrValidation('rejected', 'weak_rsa_key');
    recordPairingCsrValidation('accepted', 'valid');
    recordDeviceAuthAttempt({
      configuredMode: 'dual',
      authMethod: 'signature',
      result: 'success',
      reason: 'authorized',
    });
    recordDeviceAuthAttempt({
      configuredMode: 'signature',
      authMethod: 'signature',
      result: 'failure',
      reason: 'missing_device_signature',
    });
    recordDeviceCommandClaim('heartbeat', 3);
    recordDeviceCommandClaim('poll', 1);

    const output = await getObservabilityRegistry().metrics();

    expect(output).toContain(
      'signhex_server_device_pairing_code_allocations_total{mode="device_request",result="collision_retry"} 1'
    );
    expect(output).toContain(
      'signhex_server_device_pairing_code_allocations_total{mode="device_request",result="success"} 1'
    );
    expect(output).toContain(
      'signhex_server_device_pairing_csr_validation_total{result="rejected",reason="weak_rsa_key"} 1'
    );
    expect(output).toContain(
      'signhex_server_device_pairing_csr_validation_total{result="accepted",reason="valid"} 1'
    );
    expect(output).toContain(
      'signhex_server_device_auth_total{configured_mode="dual",auth_method="signature",result="success",reason="authorized"} 1'
    );
    expect(output).toContain(
      'signhex_server_device_auth_total{configured_mode="signature",auth_method="signature",result="failure",reason="missing_device_signature"} 1'
    );
    expect(output).toContain('signhex_server_device_commands_claimed_total{source="heartbeat"} 3');
    expect(output).toContain('signhex_server_device_commands_claimed_total{source="poll"} 1');
  });

  it('exposes a Prometheus scrape endpoint and preserves route templates', async () => {
    await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('signhex_server_http_requests_total');
    expect(response.body).toContain('route="/api/v1/health"');
    expect(response.body).toContain('signhex_server_db_pool_connections');
    expect(response.body).toContain('signhex_fleet_players_total');
  });

  it('keeps the CMS metrics overview route JSON-shaped and blocks non-loopback scrape traffic by default', async () => {
    const overviewResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/metrics/overview',
    });

    expect(overviewResponse.statusCode).toBe(401);
    expect(overviewResponse.headers['content-type']).toContain('application/json');
    expect(overviewResponse.json()).toHaveProperty('success', false);
    expect(overviewResponse.json()).toHaveProperty('error.code', 'UNAUTHORIZED');

    const scrapeResponse = await server.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '192.168.50.10',
    });

    expect(scrapeResponse.statusCode).toBe(403);
  });
});
