import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config as appConfig } from '@/config';
import { getDatabasePool } from '@/db';

const registry = new Registry();

const OBSERVED_QUEUE_NAMES = [
  'telemetry:heartbeat',
  'telemetry:proof-of-play',
  'telemetry:screenshot',
  'ffmpeg:transcode',
  'ffmpeg:thumbnail',
  'document:convert',
  'webpage:verify-capture',
  'archive',
  'cleanup',
  'chat:media-cleanup',
  'backup',
  'backup:check',
] as const;

const OBSERVED_QUEUE_STATES = ['created', 'retry', 'active'] as const;
const FLEET_STATES = ['ACTIVE', 'INACTIVE', 'OFFLINE'] as const;

type TelemetryType = 'heartbeat' | 'proof_of_play' | 'screenshot';
type TelemetryPersistMode = 'queue' | 'inline' | 'fallback';

type JobResult = 'success' | 'error';

type S3Operation =
  | 'create_bucket'
  | 'delete_object'
  | 'get_object'
  | 'head_bucket'
  | 'head_object'
  | 'presign_get'
  | 'presign_put'
  | 'put_object';

type S3Result = 'success' | 'not_found' | 'conflict' | 'error';

const requestCounter = new Counter({
  name: 'signhex_server_http_requests_total',
  help: 'Total backend HTTP requests handled by signhex-server.',
  labelNames: ['method', 'route', 'status_class'],
  registers: [registry],
});

const requestDurationHistogram = new Histogram({
  name: 'signhex_server_http_request_duration_seconds',
  help: 'Backend HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const telemetryIngestCounter = new Counter({
  name: 'signhex_server_device_telemetry_ingest_total',
  help: 'Device telemetry ingestion attempts handled by the backend.',
  labelNames: ['telemetry_type', 'result', 'persist_mode'],
  registers: [registry],
});

const telemetryIngestDurationHistogram = new Histogram({
  name: 'signhex_server_device_telemetry_ingest_duration_seconds',
  help: 'Duration of backend device telemetry ingestion handling.',
  labelNames: ['telemetry_type', 'persist_mode', 'result'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

const heartbeatCounter = new Counter({
  name: 'signhex_server_device_heartbeats_received_total',
  help: 'Heartbeat payloads received by the backend.',
  labelNames: ['status', 'result', 'persist_mode'],
  registers: [registry],
});

const jobEnqueueCounter = new Counter({
  name: 'signhex_server_job_enqueued_total',
  help: 'Jobs enqueued into pg-boss by queue and outcome.',
  labelNames: ['queue', 'result'],
  registers: [registry],
});

const jobProcessingCounter = new Counter({
  name: 'signhex_server_job_processing_total',
  help: 'Jobs processed by queue and outcome.',
  labelNames: ['queue', 'result'],
  registers: [registry],
});

const jobProcessingDurationHistogram = new Histogram({
  name: 'signhex_server_job_processing_duration_seconds',
  help: 'Background job processing duration in seconds.',
  labelNames: ['queue', 'result'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  registers: [registry],
});

const pgBossQueueStateGauge = new Gauge({
  name: 'signhex_server_pg_boss_queue_jobs',
  help: 'Approximate pg-boss jobs by queue and state.',
  labelNames: ['queue', 'state'],
  registers: [registry],
  collect: async function collectPgBossQueueState() {
    for (const queue of OBSERVED_QUEUE_NAMES) {
      for (const state of OBSERVED_QUEUE_STATES) {
        this.set({ queue, state }, 0);
      }
    }

    const pool = getDatabasePool();
    if (!pool) {
      pgBossAvailableGauge.set(0);
      return;
    }

    try {
      const result = await pool.query<{ name: string; state: string; count: string }>(
        `
          SELECT name, state, COUNT(*)::bigint AS count
          FROM ${quoteIdentifier(appConfig.PG_BOSS_SCHEMA)}.job
          WHERE name = ANY($1::text[])
            AND state = ANY($2::text[])
          GROUP BY name, state
        `,
        [Array.from(OBSERVED_QUEUE_NAMES), Array.from(OBSERVED_QUEUE_STATES)]
      );

      pgBossAvailableGauge.set(1);
      for (const row of result.rows) {
        this.set({ queue: row.name, state: row.state }, Number(row.count));
      }
    } catch (error) {
      recordCollectionError('pg_boss');
      pgBossAvailableGauge.set(0);
      void error;
    }
  },
});

const pgBossAvailableGauge = new Gauge({
  name: 'signhex_server_pg_boss_available',
  help: 'Whether pg-boss queue metadata is queryable by the backend observability collector.',
  registers: [registry],
});

const dbPoolConnectionsGauge = new Gauge({
  name: 'signhex_server_db_pool_connections',
  help: 'Database pool connections by state.',
  labelNames: ['state'],
  registers: [registry],
  collect: function collectDbPoolConnections() {
    const pool = getDatabasePool();
    const total = pool?.totalCount ?? 0;
    const idle = pool?.idleCount ?? 0;
    const inUse = Math.max(total - idle, 0);

    this.set({ state: 'total' }, total);
    this.set({ state: 'idle' }, idle);
    this.set({ state: 'in_use' }, inUse);
  },
});

const dbPoolWaitingGauge = new Gauge({
  name: 'signhex_server_db_pool_waiting_clients',
  help: 'Clients currently waiting for a PostgreSQL pool connection.',
  registers: [registry],
  collect: function collectDbPoolWaiting() {
    const pool = getDatabasePool();
    this.set(pool?.waitingCount ?? 0);
  },
});

const s3OperationCounter = new Counter({
  name: 'signhex_server_s3_operations_total',
  help: 'S3 or MinIO operations attempted by signhex-server.',
  labelNames: ['operation', 'result'],
  registers: [registry],
});

const s3OperationDurationHistogram = new Histogram({
  name: 'signhex_server_s3_operation_duration_seconds',
  help: 'S3 or MinIO operation duration in seconds.',
  labelNames: ['operation', 'result'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const websocketConnectionsGauge = new Gauge({
  name: 'signhex_server_websocket_connections',
  help: 'Current websocket connections on signhex-server.',
  registers: [registry],
});

const fleetPlayersGauge = new Gauge({
  name: 'signhex_fleet_players_total',
  help: 'Current screen fleet totals derived from backend state.',
  labelNames: ['state'],
  registers: [registry],
  collect: async function collectFleetPlayers() {
    for (const state of FLEET_STATES) {
      this.set({ state }, 0);
    }

    const pool = getDatabasePool();
    if (!pool) {
      latestHeartbeatAgeGauge.set(0);
      recentHeartbeatsGauge.set(0);
      return;
    }

    try {
      const [screenCounts, latestHeartbeat, heartbeatsLast5m] = await Promise.all([
        pool.query<{ status: string; count: string }>(
          `
            SELECT status, COUNT(*)::bigint AS count
            FROM screens
            GROUP BY status
          `
        ),
        pool.query<{ age_seconds: number | null }>(
          `
            SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::double precision AS age_seconds
            FROM heartbeats
          `
        ),
        pool.query<{ count: string }>(
          `
            SELECT COUNT(*)::bigint AS count
            FROM heartbeats
            WHERE created_at >= NOW() - INTERVAL '5 minutes'
          `
        ),
      ]);

      for (const row of screenCounts.rows) {
        if (FLEET_STATES.includes(row.status as (typeof FLEET_STATES)[number])) {
          this.set({ state: row.status }, Number(row.count));
        }
      }

      const latestAge = latestHeartbeat.rows[0]?.age_seconds;
      latestHeartbeatAgeGauge.set(Number.isFinite(latestAge) && latestAge !== null ? Math.max(latestAge, 0) : 0);
      recentHeartbeatsGauge.set(Number(heartbeatsLast5m.rows[0]?.count ?? 0));
    } catch (error) {
      recordCollectionError('fleet_rollups');
      latestHeartbeatAgeGauge.set(0);
      recentHeartbeatsGauge.set(0);
      void error;
    }
  },
});

const latestHeartbeatAgeGauge = new Gauge({
  name: 'signhex_fleet_latest_heartbeat_age_seconds',
  help: 'Age in seconds of the most recent heartbeat persisted by the backend.',
  registers: [registry],
});

const recentHeartbeatsGauge = new Gauge({
  name: 'signhex_fleet_heartbeats_last_5m',
  help: 'Heartbeats persisted during the last five minutes.',
  registers: [registry],
});

const collectionErrorsCounter = new Counter({
  name: 'signhex_server_observability_collection_errors_total',
  help: 'Observability collector errors encountered while gathering scrape-time gauges.',
  labelNames: ['collector'],
  registers: [registry],
});

const registeredCollectors = [pgBossQueueStateGauge, dbPoolConnectionsGauge, dbPoolWaitingGauge, fleetPlayersGauge];
void registeredCollectors;

let defaultMetricsInitialized = false;

function initializeDefaultMetrics() {
  if (defaultMetricsInitialized) {
    return;
  }

  collectDefaultMetrics({ register: registry });
  defaultMetricsInitialized = true;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function recordCollectionError(collector: 'pg_boss' | 'fleet_rollups') {
  try {
    collectionErrorsCounter.inc({ collector });
  } catch {
    // Observability must never break runtime paths.
  }
}

function safeRecord(callback: () => void) {
  try {
    callback();
  } catch {
    // Metrics failures are intentionally swallowed.
  }
}

function resolveRouteTemplate(request: FastifyRequest) {
  const routeOptionsUrl = (request as FastifyRequest & { routeOptions?: { url?: string } }).routeOptions?.url;
  if (typeof routeOptionsUrl === 'string' && routeOptionsUrl.length > 0) {
    return routeOptionsUrl;
  }

  const routerPath = (request as FastifyRequest & { routerPath?: string }).routerPath;
  if (typeof routerPath === 'string' && routerPath.length > 0) {
    return routerPath;
  }

  return 'unmatched';
}

function getStatusClass(statusCode: number) {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

export function ensureObservabilityInitialized() {
  initializeDefaultMetrics();
}

export function getObservabilityRegistry() {
  initializeDefaultMetrics();
  return registry;
}

export function observeHttpRequest(request: FastifyRequest, reply: FastifyReply, durationSeconds: number) {
  safeRecord(() => {
    const labels = {
      method: request.method,
      route: resolveRouteTemplate(request),
      status_class: getStatusClass(reply.statusCode),
    };

    requestCounter.inc(labels);
    requestDurationHistogram.observe(labels, durationSeconds);
  });
}

export function recordTelemetryIngest(params: {
  telemetryType: TelemetryType;
  persistMode: TelemetryPersistMode;
  result: 'success' | 'error';
  durationSeconds: number;
  heartbeatStatus?: 'ONLINE' | 'OFFLINE' | 'ERROR';
}) {
  safeRecord(() => {
    telemetryIngestCounter.inc({
      telemetry_type: params.telemetryType,
      result: params.result,
      persist_mode: params.persistMode,
    });
    telemetryIngestDurationHistogram.observe(
      {
        telemetry_type: params.telemetryType,
        persist_mode: params.persistMode,
        result: params.result,
      },
      params.durationSeconds
    );

    if (params.telemetryType === 'heartbeat' && params.heartbeatStatus) {
      heartbeatCounter.inc({
        status: params.heartbeatStatus,
        result: params.result,
        persist_mode: params.persistMode,
      });
    }
  });
}

export function recordJobEnqueue(queue: string, result: JobResult) {
  safeRecord(() => {
    jobEnqueueCounter.inc({ queue, result });
  });
}

export async function observeJobProcessing<T>(queue: string, work: () => Promise<T>) {
  const start = process.hrtime.bigint();

  try {
    const result = await work();
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    safeRecord(() => {
      jobProcessingCounter.inc({ queue, result: 'success' });
      jobProcessingDurationHistogram.observe({ queue, result: 'success' }, durationSeconds);
    });
    return result;
  } catch (error) {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    safeRecord(() => {
      jobProcessingCounter.inc({ queue, result: 'error' });
      jobProcessingDurationHistogram.observe({ queue, result: 'error' }, durationSeconds);
    });
    throw error;
  }
}

function classifyS3Error(error: unknown): S3Result {
  const metadataStatus = typeof error === 'object' && error !== null ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined;
  if (metadataStatus === 404) return 'not_found';
  if (metadataStatus === 409 || metadataStatus === 412) return 'conflict';

  const errorName = typeof error === 'object' && error !== null ? (error as { name?: string }).name : undefined;
  if (errorName === 'NotFound' || errorName === 'NoSuchKey') return 'not_found';
  if (errorName === 'Conflict' || errorName === 'PreconditionFailed') return 'conflict';
  return 'error';
}

export async function observeS3Operation<T>(operation: S3Operation, work: () => Promise<T>) {
  const start = process.hrtime.bigint();

  try {
    const result = await work();
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    safeRecord(() => {
      s3OperationCounter.inc({ operation, result: 'success' });
      s3OperationDurationHistogram.observe({ operation, result: 'success' }, durationSeconds);
    });
    return result;
  } catch (error) {
    const result = classifyS3Error(error);
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    safeRecord(() => {
      s3OperationCounter.inc({ operation, result });
      s3OperationDurationHistogram.observe({ operation, result }, durationSeconds);
    });
    throw error;
  }
}

export function setWebsocketConnections(count: number) {
  safeRecord(() => {
    websocketConnectionsGauge.set(Math.max(count, 0));
  });
}

export function resetObservabilityMetricsForTests() {
  registry.resetMetrics();
  setWebsocketConnections(0);
  pgBossAvailableGauge.set(0);
  latestHeartbeatAgeGauge.set(0);
  recentHeartbeatsGauge.set(0);
}
