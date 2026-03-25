import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { AddressInfo } from 'net';
import { FastifyInstance } from 'fastify';
import { io as createClient, Socket as ClientSocket } from 'socket.io-client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { hashPassword } from '@/auth/password';
import { HTTP_STATUS } from '@/http-status-codes';
import { createNotificationCounterRepository } from '@/db/repositories/notification-counter';
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

async function tableExists(tableName: string) {
  const db = getDatabase();
  const result = await db.execute<{ regclass: string | null }>(
    sql`SELECT to_regclass(${`public.${tableName}`}) AS regclass`
  );
  const first = result.rows[0] as { regclass?: string | null } | undefined;
  return Boolean(first?.regclass);
}

function waitForCountEvent(
  socket: ClientSocket,
  predicate: (payload: { unread_total: number }) => boolean,
  timeoutMs = 6000
): Promise<{ unread_total: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('notifications:count', handler);
      reject(new Error('Timed out waiting for notifications:count'));
    }, timeoutMs);

    const handler = (payload: { unread_total: number }) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off('notifications:count', handler);
      resolve(payload);
    };

    socket.on('notifications:count', handler);
  });
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

describe('notifications namespace realtime count updates', () => {
  let server: FastifyInstance;
  let baseUrl: string;
  let senderToken: string;
  let recipientToken: string;
  let recipientId: string;
  let recipientEmail: string;
  let socket: ClientSocket | null = null;

  const counterRepo = createNotificationCounterRepository();

  beforeAll(async () => {
    server = await createTestServer();

    if (!(await tableExists('chat_conversations'))) {
      await applyMigrationFile('0008_chat_core.sql');
    }
    await applyMigrationFile('0011_notifications_payload_fields.sql');
    await applyMigrationFile('0012_chat_dm_pair_active_unique.sql');
    await applyMigrationFile('0014_chat_pins_bookmarks_and_also_to_channel.sql');
    await applyMigrationFile('0015_notification_unread_counters.sql');

    const db = getDatabase();
    const [adminRole] = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.name, 'ADMIN'))
      .limit(1);
    const [operatorRole] = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.name, 'OPERATOR'))
      .limit(1);
    if (!adminRole || !operatorRole) {
      throw new Error('ADMIN and OPERATOR roles are required');
    }

    recipientId = randomUUID();
    recipientEmail = `notif-recipient-${Date.now()}@example.com`;
    await db.insert(schema.users).values({
      id: recipientId,
      email: recipientEmail,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Notif',
      last_name: 'Receiver',
      role_id: operatorRole.id,
      is_active: true,
    });

    senderToken = await issueTokenForUser({
      id: testUser.id,
      email: testUser.email,
      roleId: adminRole.id,
      roleName: adminRole.name,
    });
    recipientToken = await issueTokenForUser({
      id: recipientId,
      email: recipientEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });

    await counterRepo.reconcile(testUser.id);
    await counterRepo.reconcile(recipientId);
    await counterRepo.set(recipientId, 0);

    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    await closeTestServer(server);
  });

  it('emits notifications:count increment when recipient gets a new DM notification', async () => {
    socket = createClient(`${baseUrl}/notifications`, {
      transports: ['websocket'],
      auth: { token: recipientToken },
      reconnection: false,
      forceNew: true,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
      socket!.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket!.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const initial = await waitForCountEvent(socket, () => true);

    const expectedCountPromise = waitForCountEvent(
      socket,
      (payload) => payload.unread_total === initial.unread_total + 1
    );

    const dmResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/dm',
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { otherUserId: recipientId },
    });
    expect(dmResponse.statusCode).toBe(HTTP_STATUS.OK);
    const conversationId = JSON.parse(dmResponse.body).conversation.id as string;

    const sendResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${senderToken}` },
      payload: { text: 'hello receiver' },
    });
    expect(sendResponse.statusCode).toBe(HTTP_STATUS.OK);

    const updated = await expectedCountPromise;
    expect(updated.unread_total).toBe(initial.unread_total + 1);
  });
});
