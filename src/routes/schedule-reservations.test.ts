import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { hashPassword } from '@/auth/password';
import { HTTP_STATUS } from '@/http-status-codes';

async function issueSuperAdminToken(userId: string, email: string) {
  const db = getDatabase();
  const [superAdminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'SUPER_ADMIN')).limit(1);
  if (!superAdminRole) {
    throw new Error('SUPER_ADMIN role is required for reservation tests');
  }

  const token = await generateAccessToken(userId, email, superAdminRole.id, superAdminRole.name);
  await createSessionRepository().create({
    user_id: userId,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return { token: token.token, roleId: superAdminRole.id };
}

async function ensureUser(id: string, email: string, roleId: string) {
  const db = getDatabase();
  await db
    .insert(schema.users)
    .values({
      id,
      email,
      password_hash: await hashPassword('TestPassword123!'),
      first_name: email.split('@')[0],
      last_name: 'Admin',
      role_id: roleId,
      is_active: true,
    })
    .onConflictDoNothing();
}

async function seedReadySchedule(params: {
  screenId: string;
  createdBy: string;
  name: string;
  startAt: Date;
  endAt: Date;
}) {
  const db = getDatabase();
  const mediaId = randomUUID();
  const presentationId = randomUUID();
  const scheduleId = randomUUID();
  const scheduleItemId = randomUUID();

  await db.insert(schema.media).values({
    id: mediaId,
    name: `${params.name} Media`,
    type: 'IMAGE',
    status: 'READY',
    created_by: params.createdBy,
  });

  await db.insert(schema.presentations).values({
    id: presentationId,
    name: `${params.name} Presentation`,
    created_by: params.createdBy,
  });

  await db.insert(schema.presentationItems).values({
    id: randomUUID(),
    presentation_id: presentationId,
    media_id: mediaId,
    order: 0,
    duration_seconds: 15,
  });

  await db.insert(schema.schedules).values({
    id: scheduleId,
    name: params.name,
    start_at: params.startAt,
    end_at: params.endAt,
    is_active: true,
    created_by: params.createdBy,
  });

  await db.insert(schema.scheduleItems).values({
    id: scheduleItemId,
    schedule_id: scheduleId,
    presentation_id: presentationId,
    start_at: params.startAt,
    end_at: params.endAt,
    priority: 0,
    screen_ids: [params.screenId],
    screen_group_ids: [],
  });

  return { scheduleId };
}

describe('Hybrid schedule reservations', () => {
  let server: FastifyInstance;
  let tokenOne: string;
  let tokenTwo: string;
  let secondUserId: string;

  beforeAll(async () => {
    server = await createTestServer();
    const firstAuth = await issueSuperAdminToken(testUser.id, testUser.email);
    tokenOne = firstAuth.token;

    secondUserId = randomUUID();
    await ensureUser(secondUserId, 'second-admin@example.com', firstAuth.roleId);
    tokenTwo = (await issueSuperAdminToken(secondUserId, 'second-admin@example.com')).token;
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('acquires a hold on submit and blocks overlapping request submission for another user', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() + 20 * 60 * 1000);
    const endAt = new Date(now.getTime() + 80 * 60 * 1000);

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Reservation Screen',
      status: 'OFFLINE',
    });

    const scheduleOne = await seedReadySchedule({
      screenId,
      createdBy: testUser.id,
      name: 'Reservation Schedule One',
      startAt,
      endAt,
    });

    const scheduleTwo = await seedReadySchedule({
      screenId,
      createdBy: secondUserId,
      name: 'Reservation Schedule Two',
      startAt: new Date(startAt.getTime() + 5 * 60 * 1000),
      endAt: new Date(endAt.getTime() - 5 * 60 * 1000),
    });

    const firstResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/schedule-requests',
      headers: { authorization: `Bearer ${tokenOne}` },
      payload: {
        schedule_id: scheduleOne.scheduleId,
        notes: 'first hold',
      },
    });

    expect(firstResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const firstBody = JSON.parse(firstResponse.body);
    expect(firstBody.reservation_summary?.state).toBe('HELD');
    expect(firstBody.reservation_summary?.version).toBe(1);

    const secondResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/schedule-requests',
      headers: { authorization: `Bearer ${tokenTwo}` },
      payload: {
        schedule_id: scheduleTwo.scheduleId,
        notes: 'second hold',
      },
    });

    expect(secondResponse.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const secondBody = JSON.parse(secondResponse.body);
    expect(secondBody.error.details?.conflict_type).toBe('SCREEN_TIME_WINDOW_CONFLICT');
    expect(secondBody.error.details?.reservation_conflicts?.[0]?.screen_id).toBe(screenId);
  });

  it('promotes a hold to reserved, publishes it, and rejects conflicting direct publish', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() + 100 * 60 * 1000);
    const endAt = new Date(now.getTime() + 160 * 60 * 1000);

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Reserved Publish Screen',
      status: 'OFFLINE',
    });

    const requestSchedule = await seedReadySchedule({
      screenId,
      createdBy: testUser.id,
      name: 'Reserved Publish Schedule',
      startAt,
      endAt,
    });

    const conflictingSchedule = await seedReadySchedule({
      screenId,
      createdBy: secondUserId,
      name: 'Direct Publish Conflict Schedule',
      startAt,
      endAt,
    });

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/schedule-requests',
      headers: { authorization: `Bearer ${tokenOne}` },
      payload: {
        schedule_id: requestSchedule.scheduleId,
        notes: 'approve then publish',
      },
    });

    const createdBody = JSON.parse(created.body);
    const requestId = createdBody.id as string;

    const approved = await server.inject({
      method: 'POST',
      url: `/api/v1/schedule-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${tokenOne}` },
      payload: { comment: 'approved' },
    });

    expect(approved.statusCode).toBe(HTTP_STATUS.OK);
    const approvedBody = JSON.parse(approved.body);
    expect(approvedBody.reservation_summary?.state).toBe('RESERVED');

    const published = await server.inject({
      method: 'POST',
      url: `/api/v1/schedule-requests/${requestId}/publish`,
      headers: { authorization: `Bearer ${tokenOne}` },
    });

    expect(published.statusCode).toBe(HTTP_STATUS.OK);
    const publishedBody = JSON.parse(published.body);
    expect(publishedBody.publish_id).toBeTruthy();

    const refreshCommands = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.screen_id, screenId));
    expect(refreshCommands.some((command) => command.type === 'REFRESH' && command.status === 'PENDING')).toBe(true);
    const refreshPayload = refreshCommands.find((command) => command.type === 'REFRESH')?.payload as
      | { reason?: string; publish_id?: string | null; snapshot_id?: string | null }
      | undefined;
    expect(refreshPayload?.reason).toBe('PUBLISH');
    expect(refreshPayload?.publish_id).toBe(publishedBody.publish_id);
    expect(refreshPayload?.snapshot_id).toBe(publishedBody.snapshot_id);

    const requestDetail = await server.inject({
      method: 'GET',
      url: `/api/v1/schedule-requests/${requestId}`,
      headers: { authorization: `Bearer ${tokenOne}` },
    });

    const requestDetailBody = JSON.parse(requestDetail.body);
    expect(requestDetailBody.status).toBe('PUBLISHED');
    expect(requestDetailBody.reservation_summary?.state).toBe('PUBLISHED');

    const conflictingPublish = await server.inject({
      method: 'POST',
      url: `/api/v1/schedules/${conflictingSchedule.scheduleId}/publish`,
      headers: { authorization: `Bearer ${tokenTwo}` },
      payload: {
        screen_ids: [screenId],
      },
    });

    expect(conflictingPublish.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const conflictingBody = JSON.parse(conflictingPublish.body);
    expect(conflictingBody.error.details?.conflict_type).toBe('SCREEN_TIME_WINDOW_CONFLICT');
  });

  it('allows an admin to take down a published request and clears active ownership for the screen', async () => {
    const db = getDatabase();
    const screenId = randomUUID();
    const now = new Date();
    const startAt = new Date(now.getTime() + 180 * 60 * 1000);
    const endAt = new Date(now.getTime() + 240 * 60 * 1000);

    await db.insert(schema.screens).values({
      id: screenId,
      name: 'Take Down Screen',
      status: 'OFFLINE',
    });

    const publishedSchedule = await seedReadySchedule({
      screenId,
      createdBy: testUser.id,
      name: 'Take Down Schedule',
      startAt,
      endAt,
    });

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/schedule-requests',
      headers: { authorization: `Bearer ${tokenOne}` },
      payload: {
        schedule_id: publishedSchedule.scheduleId,
        notes: 'publish then take down',
      },
    });

    const createdBody = JSON.parse(created.body);
    const requestId = createdBody.id as string;

    await server.inject({
      method: 'POST',
      url: `/api/v1/schedule-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${tokenOne}` },
      payload: { comment: 'approved for takedown test' },
    });

    const published = await server.inject({
      method: 'POST',
      url: `/api/v1/schedule-requests/${requestId}/publish`,
      headers: { authorization: `Bearer ${tokenOne}` },
    });

    expect(published.statusCode).toBe(HTTP_STATUS.OK);

    const takenDown = await server.inject({
      method: 'POST',
      url: `/api/v1/schedule-requests/${requestId}/take-down`,
      headers: { authorization: `Bearer ${tokenOne}` },
      payload: { reason: 'Removed by admin' },
    });

    expect(takenDown.statusCode).toBe(HTTP_STATUS.OK);
    const takenDownBody = JSON.parse(takenDown.body);
    expect(takenDownBody.status).toBe('TAKEN_DOWN');
    expect(takenDownBody.takedown_reason).toBe('Removed by admin');
    expect(takenDownBody.resolved_screen_ids).toContain(screenId);

    const reservations = await db
      .select()
      .from(schema.scheduleReservations)
      .where(eq(schema.scheduleReservations.schedule_request_id, requestId));
    expect(reservations.every((row) => row.state === 'RELEASED')).toBe(true);
    expect(reservations.every((row) => row.release_reason === 'request-taken-down-by-admin')).toBe(true);

    const refreshCommands = await db
      .select()
      .from(schema.deviceCommands)
      .where(eq(schema.deviceCommands.screen_id, screenId));
    expect(refreshCommands.some((command) => command.type === 'REFRESH' && command.status === 'PENDING')).toBe(true);
    const refreshReasons = refreshCommands
      .filter((command) => command.type === 'REFRESH')
      .map((command) => (command.payload as { reason?: string } | null)?.reason);
    expect(refreshReasons).toContain('TAKE_DOWN');

    const requestDetail = await server.inject({
      method: 'GET',
      url: `/api/v1/schedule-requests/${requestId}`,
      headers: { authorization: `Bearer ${tokenOne}` },
    });

    const detailBody = JSON.parse(requestDetail.body);
    expect(detailBody.status).toBe('TAKEN_DOWN');
    expect(detailBody.taken_down_at).toBeTruthy();
    expect(detailBody.takedown_reason).toBe('Removed by admin');

    const deviceSnapshot = await server.inject({
      method: 'GET',
      url: `/api/v1/device/${screenId}/snapshot`,
      headers: { authorization: `Bearer ${tokenOne}` },
    });

    expect(deviceSnapshot.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
  });
});
