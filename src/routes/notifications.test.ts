import { readFile } from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { createTestServer, closeTestServer, testUser } from '@/test/helpers';
import { createNotificationRepository } from '@/db/repositories/notification';
import { createNotificationCounterRepository } from '@/db/repositories/notification-counter';
import { getDatabase, schema } from '@/db';
import { HTTP_STATUS } from '@/http-status-codes';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';

async function applyMigrationFile(filename: string) {
  const db = getDatabase();
  const migrationPath = path.resolve(process.cwd(), 'drizzle', 'migrations', filename);
  const content = await readFile(migrationPath, 'utf8');
  const statements = content
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      await db.execute(sql.raw(statement));
    } catch (error) {
      const code =
        typeof error === 'object' && error && 'code' in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== '42P07' && code !== '42710' && code !== '23505') {
        throw error;
      }
    }
  }
}

async function issueTokenForUser(user: {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
}) {
  const token = await generateAccessToken(user.id, user.email, user.roleId, user.roleName);
  await createSessionRepository().create({
    user_id: user.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

describe('Notification routes - unread badge counter', () => {
  let server: FastifyInstance;
  let token: string;

  const notifRepo = createNotificationRepository();
  const counterRepo = createNotificationCounterRepository();

  beforeAll(async () => {
    server = await createTestServer();
    await applyMigrationFile('0011_notifications_payload_fields.sql');
    await applyMigrationFile('0015_notification_unread_counters.sql');
    const db = getDatabase();
    const [adminRole] = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.name, 'ADMIN'))
      .limit(1);
    if (!adminRole) throw new Error('ADMIN role is required');

    token = await issueTokenForUser({
      id: testUser.id,
      email: testUser.email,
      roleId: adminRole.id,
      roleName: adminRole.name,
    });
  });

  beforeEach(async () => {
    await notifRepo.markAllAsRead(testUser.id);
    await counterRepo.set(testUser.id, 0);
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('returns unread count from server-authoritative counter', async () => {
    await notifRepo.create({
      user_id: testUser.id,
      title: 'Unread badge test',
      message: 'one',
      type: 'INFO',
      data: { source: 'test' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/notifications/unread-count',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(response.body);
    expect(body.unread_total).toBe(1);
  });

  it('create notification increments unread counter', async () => {
    const before = await counterRepo.getUnreadTotal(testUser.id);

    await notifRepo.create({
      user_id: testUser.id,
      title: 'Increment test',
      message: 'new',
      type: 'INFO',
      data: { source: 'test' },
    });

    const after = await counterRepo.getUnreadTotal(testUser.id);
    expect(after).toBe(before + 1);
  });

  it('mark-read decrements counter only once (idempotent)', async () => {
    const created = await notifRepo.create({
      user_id: testUser.id,
      title: 'Mark read test',
      message: 'mark me',
      type: 'INFO',
      data: { source: 'test' },
    });

    const first = await server.inject({
      method: 'POST',
      url: `/api/v1/notifications/${created.id}/read`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(HTTP_STATUS.OK);
    expect((await counterRepo.getUnreadTotal(testUser.id))).toBe(0);

    const second = await server.inject({
      method: 'POST',
      url: `/api/v1/notifications/${created.id}/read`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(HTTP_STATUS.OK);
    expect((await counterRepo.getUnreadTotal(testUser.id))).toBe(0);
  });

  it('read-all sets unread counter to zero', async () => {
    await notifRepo.create({
      user_id: testUser.id,
      title: 'read-all-1',
      message: 'a',
      type: 'INFO',
    });
    await notifRepo.create({
      user_id: testUser.id,
      title: 'read-all-2',
      message: 'b',
      type: 'INFO',
    });
    expect(await counterRepo.getUnreadTotal(testUser.id)).toBe(2);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    expect(await counterRepo.getUnreadTotal(testUser.id)).toBe(0);
  });
});
