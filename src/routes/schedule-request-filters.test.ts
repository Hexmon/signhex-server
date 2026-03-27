import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';

async function issueSuperAdminToken() {
  const db = getDatabase();
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!role) {
    throw new Error('SUPER_ADMIN role is required for schedule filter tests');
  }

  const token = await generateAccessToken(testUser.id, testUser.email, role.id, role.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });

  return token.token;
}

async function seedRequest(params: {
  name: string;
  startAt: Date;
  endAt: Date;
  createdAt: Date;
  status?: 'PENDING' | 'APPROVED';
  notes?: string;
}) {
  const db = getDatabase();
  const scheduleId = randomUUID();
  const requestId = randomUUID();

  await db.insert(schema.schedules).values({
    id: scheduleId,
    name: params.name,
    start_at: params.startAt,
    end_at: params.endAt,
    created_by: testUser.id,
    created_at: params.createdAt,
    updated_at: params.createdAt,
    is_active: true,
  });

  await db.insert(schema.scheduleRequests).values({
    id: requestId,
    schedule_id: scheduleId,
    schedule_payload: {},
    status: params.status ?? 'PENDING',
    notes: params.notes ?? null,
    requested_by: testUser.id,
    created_at: params.createdAt,
    updated_at: params.createdAt,
  });

  return { requestId, scheduleId };
}

describe('Schedule request filters', () => {
  let server: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    server = await createTestServer();
    token = await issueSuperAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('filters schedule requests by created date and search, and applies the same scope to summary counts', async () => {
    const db = getDatabase();
    await db.delete(schema.scheduleRequests);
    await db.delete(schema.schedules);

    const jan05 = new Date('2026-01-05T10:00:00.000Z');
    const jan12 = new Date('2026-01-12T10:00:00.000Z');
    const jan20 = new Date('2026-01-20T10:00:00.000Z');

    await seedRequest({
      name: 'Alpha Campaign',
      startAt: new Date('2026-02-01T09:00:00.000Z'),
      endAt: new Date('2026-02-01T12:00:00.000Z'),
      createdAt: jan05,
      status: 'PENDING',
      notes: 'alpha request',
    });
    await seedRequest({
      name: 'Bravo Campaign',
      startAt: new Date('2026-02-02T09:00:00.000Z'),
      endAt: new Date('2026-02-02T12:00:00.000Z'),
      createdAt: jan12,
      status: 'APPROVED',
      notes: 'bravo request',
    });
    await seedRequest({
      name: 'Alpha Followup',
      startAt: new Date('2026-02-03T09:00:00.000Z'),
      endAt: new Date('2026-02-03T12:00:00.000Z'),
      createdAt: jan20,
      status: 'PENDING',
      notes: 'late alpha request',
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/schedule-requests?status=PENDING&include=schedule&q=alpha&date_field=created_at&date_from=${encodeURIComponent(
        '2026-01-01T00:00:00.000Z'
      )}&date_to=${encodeURIComponent('2026-01-15T23:59:59.999Z')}&sort_direction=asc`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      items: Array<{ id: string; schedule?: { name?: string | null }; created_at?: string }>;
      pagination: { total: number };
    };
    expect(body.pagination.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.schedule?.name).toBe('Alpha Campaign');

    const summaryResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/schedule-requests/status-summary?q=alpha&date_field=created_at&date_from=${encodeURIComponent(
        '2026-01-01T00:00:00.000Z'
      )}&date_to=${encodeURIComponent('2026-01-15T23:59:59.999Z')}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(summaryResponse.statusCode).toBe(200);
    const summaryBody = JSON.parse(summaryResponse.body) as {
      counts: { pending: number; approved: number; rejected: number; published: number; taken_down: number; expired: number };
    };
    expect(summaryBody.counts.pending).toBe(1);
    expect(summaryBody.counts.approved).toBe(0);
  });

  it('filters schedule requests by overlapping schedule window and sorts by schedule start date', async () => {
    const db = getDatabase();
    await db.delete(schema.scheduleRequests);
    await db.delete(schema.schedules);

    await seedRequest({
      name: 'Window Early',
      startAt: new Date('2026-03-04T09:00:00.000Z'),
      endAt: new Date('2026-03-09T12:00:00.000Z'),
      createdAt: new Date('2026-02-01T10:00:00.000Z'),
      status: 'PENDING',
    });
    await seedRequest({
      name: 'Window Mid',
      startAt: new Date('2026-03-10T09:00:00.000Z'),
      endAt: new Date('2026-03-12T12:00:00.000Z'),
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
      status: 'PENDING',
    });
    await seedRequest({
      name: 'Window Late',
      startAt: new Date('2026-03-20T09:00:00.000Z'),
      endAt: new Date('2026-03-22T12:00:00.000Z'),
      createdAt: new Date('2026-02-03T10:00:00.000Z'),
      status: 'PENDING',
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/schedule-requests?status=PENDING&include=schedule&date_field=schedule_window&date_from=${encodeURIComponent(
        '2026-03-08T00:00:00.000Z'
      )}&date_to=${encodeURIComponent('2026-03-15T23:59:59.999Z')}&sort_direction=asc`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      items: Array<{ schedule?: { name?: string | null } }>;
      pagination: { total: number };
    };

    expect(body.pagination.total).toBe(2);
    expect(body.items.map((item) => item.schedule?.name)).toEqual(['Window Early', 'Window Mid']);
  });
});
