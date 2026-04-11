import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { HTTP_STATUS } from '@/http-status-codes';
import * as s3 from '@/s3';

type OverviewResponseBody = {
  current_state_source: string;
  fleet: {
    total_players: number | null;
  };
  alerts: {
    firing: number;
  };
  machines: Array<{
    name: string;
    scrape_status: {
      reachable_targets: number;
    };
  }>;
  grafana: {
    links: {
      players_fleet: string | null;
    };
  };
};

async function issueRoleToken(roleName: 'ADMIN' | 'OPERATOR') {
  const db = getDatabase();
  const [roleRecord] = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.name, roleName))
    .limit(1);
  if (!roleRecord) {
    throw new Error(`${roleName} role is required for observability route tests`);
  }

  const currentPermissions =
    roleRecord.permissions && typeof roleRecord.permissions === 'object'
      ? (roleRecord.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];
  for (const grant of [
    { action: 'read', subject: 'Dashboard' },
    { action: 'read', subject: 'Screen' },
  ]) {
    if (
      !mergedGrants.some(
        (current) => current.action === grant.action && current.subject === grant.subject
      )
    ) {
      mergedGrants.push(grant);
    }
  }

  await db
    .update(schema.roles)
    .set({ permissions: { grants: mergedGrants } })
    .where(eq(schema.roles.id, roleRecord.id));

  const token = await generateAccessToken(
    testUser.id,
    testUser.email,
    roleRecord.id,
    roleRecord.name
  );
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

function createPrometheusResponse(
  result: Array<{
    metric: Record<string, string>;
    value: string;
  }>
) {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: result.map((entry) => ({
        metric: entry.metric,
        value: [Date.now() / 1000, entry.value] as [number, string],
      })),
    },
  };
}

describe('Observability CMS summary routes', () => {
  let server: FastifyInstance;
  let adminToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueRoleToken('ADMIN');
    operatorToken = await issueRoleToken('OPERATOR');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await closeTestServer(server);
  });

  it('returns a CMS-safe observability overview with machine summaries', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const query = url.searchParams.get('query') ?? '';

      if (query === 'signhex_fleet_players_total') {
        return new Response(
          JSON.stringify(
            createPrometheusResponse([
              { metric: { __name__: 'signhex_fleet_players_total', state: 'ACTIVE' }, value: '5' },
              { metric: { __name__: 'signhex_fleet_players_total', state: 'OFFLINE' }, value: '1' },
            ])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (query === 'up{job="players"}') {
        return new Response(
          JSON.stringify(
            createPrometheusResponse([
              { metric: { __name__: 'up', job: 'players', device_id: 'screen-1' }, value: '1' },
              { metric: { __name__: 'up', job: 'players', device_id: 'screen-2' }, value: '0' },
            ])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (query === 'count by (severity) (ALERTS{alertstate="firing"})') {
        return new Response(
          JSON.stringify(
            createPrometheusResponse([{ metric: { severity: 'warning' }, value: '2' }])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (query.startsWith('up{machine=')) {
        return new Response(
          JSON.stringify(
            createPrometheusResponse([
              {
                metric: { __name__: 'up', machine: 'dev-local', job: 'signhex-server' },
                value: '1',
              },
              { metric: { __name__: 'up', machine: 'dev-local', job: 'vm2-node' }, value: '1' },
            ])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (query.startsWith('100 * (1 - avg by(machine)')) {
        return new Response(
          JSON.stringify(
            createPrometheusResponse([{ metric: { machine: 'dev-local' }, value: '21.3' }])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (query.startsWith('100 * (1 - (node_memory_MemAvailable_bytes')) {
        return new Response(
          JSON.stringify(
            createPrometheusResponse([{ metric: { machine: 'dev-local' }, value: '47.9' }])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (query.startsWith('max by(machine) (100 * (1 - (node_filesystem_avail_bytes')) {
        return new Response(
          JSON.stringify(
            createPrometheusResponse([{ metric: { machine: 'dev-local' }, value: '62.5' }])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify(createPrometheusResponse([])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/observability/overview',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as OverviewResponseBody;
    expect(body.current_state_source).toBe('backend_and_prometheus');
    expect(body.fleet.total_players).toBe(6);
    expect(body.alerts.firing).toBe(2);
    expect(body.machines).toHaveLength(1);
    expect(body.machines[0].name).toContain('Development');
    expect(body.machines[0].scrape_status.reachable_targets).toBe(2);
    expect(body.grafana.links.players_fleet).toContain('/grafana/d/signhex-players-fleet');
  });

  it('allows operators to read the observability overview route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              createPrometheusResponse([
                {
                  metric: { __name__: 'signhex_fleet_players_total', state: 'ACTIVE' },
                  value: '2',
                },
              ])
            ),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/observability/overview',
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as OverviewResponseBody;
    expect(body.current_state_source).toBe('backend_and_prometheus');
  });

  it('returns per-screen observability summary with backend telemetry and player scrape details', async () => {
    const screenId = randomUUID();
    const storageObjectId = randomUUID();
    const db = getDatabase();

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Observability Screen',
      status: 'ACTIVE',
      last_heartbeat_at: new Date('2026-04-08T09:00:00.000Z'),
    });

    await db.insert(schema.storageObjects).values({
      id: storageObjectId,
      bucket: 'telemetry',
      object_key: `heartbeats/${screenId}.json`,
      content_type: 'application/json',
      size: 128,
    });

    await db.insert(schema.heartbeats).values({
      screen_id: screenId,
      status: 'ONLINE',
      storage_object_id: storageObjectId,
    });

    vi.spyOn(s3, 'getObject').mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          cpu_usage: 18.5,
          memory_total_mb: 4096,
          memory_used_mb: 1024,
          disk_total_gb: 64,
          disk_used_gb: 20,
        }),
        'utf8'
      )
    );

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            createPrometheusResponse([
              { metric: { __name__: 'up', job: 'players', device_id: screenId }, value: '1' },
              {
                metric: {
                  __name__: 'signhex_player_last_successful_heartbeat_unixtime',
                  device_id: screenId,
                },
                value: String(Date.parse('2026-04-08T09:01:00.000Z') / 1000),
              },
              {
                metric: {
                  __name__: 'signhex_player_system_cpu_usage_percent',
                  device_id: screenId,
                },
                value: '12.5',
              },
              {
                metric: {
                  __name__: 'signhex_player_system_memory_bytes',
                  device_id: screenId,
                  state: 'used',
                },
                value: '1073741824',
              },
              {
                metric: {
                  __name__: 'signhex_player_system_memory_bytes',
                  device_id: screenId,
                  state: 'total',
                },
                value: '4294967296',
              },
              {
                metric: {
                  __name__: 'signhex_player_request_queue_items',
                  device_id: screenId,
                  category: 'all',
                },
                value: '3',
              },
            ])
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );

    vi.stubGlobal('fetch', fetchMock);

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/observability/screens/${screenId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body) as {
      player_scrape: {
        status: string;
      };
      latest_player_metrics: {
        request_queue_items: number | null;
      };
      latest_backend_telemetry: {
        memory_used_mb?: number;
      } | null;
      grafana: {
        links: Array<{ label: string }>;
      };
    };
    expect(body.screen.id).toBe(screenId);
    expect(body.player_scrape.status).toBe('up');
    expect(body.latest_player_metrics.cpu_percent).toBe(12.5);
    expect(body.latest_backend_telemetry.cpu_usage).toBe(18.5);
    expect(body.grafana.links[0].url).toContain('/grafana/d/signhex-players-fleet');
  });
});
