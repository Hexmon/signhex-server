import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createServer } from '@/server';
import { createSessionRepository } from '@/db/repositories/session';
import { generateAccessToken } from '@/auth/jwt';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';
import { hashPassword } from '@/auth/password';
import { HTTP_STATUS } from '@/http-status-codes';
import { testRoles, testUser } from '@/test/helpers';

async function applyMigrationFile(filename: string) {
  const db = getDatabase();
  const migrationPath = path.resolve(process.cwd(), 'drizzle', 'migrations', filename);
  const content = await readFile(migrationPath, 'utf8');
  const statements = content
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
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

describe('Conversation Routes - chat DM shim', () => {
  let server: FastifyInstance;
  let adminToken: string;
  let otherUserId: string;

  beforeAll(async () => {
    await initializeDatabase();
    server = await createServer();
    if (!(await tableExists('chat_conversations'))) {
      await applyMigrationFile('0008_chat_core.sql');
    }
    await applyMigrationFile('0012_chat_dm_pair_active_unique.sql');

    const db = getDatabase();
    const ensureRole = async (
      name: string,
      fallbackId: string,
      permissions: { grants: Array<{ action: string; subject: string }> } = { grants: [] }
    ) => {
      const [existing] = await db
        .select()
        .from(schema.roles)
        .where(eq(schema.roles.name, name))
        .limit(1);
      if (existing) {
        const [updated] = await db
          .update(schema.roles)
          .set({ permissions })
          .where(eq(schema.roles.id, existing.id))
          .returning();
        return updated ?? existing;
      }
      const [created] = await db
        .insert(schema.roles)
        .values({
          id: fallbackId,
          name,
          permissions,
          is_system: true,
        })
        .returning();
      return created;
    };

    const adminRole = await ensureRole('ADMIN', testRoles.ADMIN.id, {
      grants: [{ action: 'read', subject: 'Conversation' }],
    });
    const operatorRole = await ensureRole('OPERATOR', testRoles.OPERATOR.id);

    const adminPassword = await hashPassword('Password123!');
    await db
      .insert(schema.users)
      .values({
        id: testUser.id,
        email: testUser.email,
        password_hash: adminPassword,
        first_name: testUser.first_name,
        last_name: testUser.last_name,
        role_id: adminRole.id,
        is_active: true,
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: {
          email: testUser.email,
          password_hash: adminPassword,
          first_name: testUser.first_name,
          last_name: testUser.last_name,
          role_id: adminRole.id,
          is_active: true,
        },
      });

    const token = await generateAccessToken(
      testUser.id,
      testUser.email,
      adminRole.id,
      adminRole.name
    );
    await createSessionRepository().create({
      user_id: testUser.id,
      access_jti: token.jti,
      expires_at: token.expiresAt,
    });
    adminToken = token.token;

    otherUserId = randomUUID();
    await db.insert(schema.users).values({
      id: otherUserId,
      email: `legacy-chat-shim-${Date.now()}@example.com`,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Legacy',
      last_name: 'Peer',
      role_id: operatorRole.id,
      is_active: true,
    });
  });

  afterAll(async () => {
    await server.close();
    await closeDatabase();
  });

  it('keeps legacy response shape while writing messages to chat_*', async () => {
    const db = getDatabase();

    const startResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { participant_id: otherUserId },
    });
    expect(startResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const startedConversation = JSON.parse(startResponse.body);
    expect(startedConversation).toMatchObject({
      id: expect.any(String),
      participant_a: expect.any(String),
      participant_b: expect.any(String),
    });

    const [chatConversation] = await db
      .select()
      .from(schema.chatConversations)
      .where(eq(schema.chatConversations.id, startedConversation.id))
      .limit(1);
    expect(chatConversation?.type).toBe('DM');
    expect(chatConversation?.state).toBe('ACTIVE');

    const sendResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${startedConversation.id}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        content: 'legacy shim message',
        attachments: [{ media_asset_id: randomUUID(), note: 'legacy' }],
      },
    });
    expect(sendResponse.statusCode).toBe(HTTP_STATUS.CREATED);
    const sentMessage = JSON.parse(sendResponse.body);
    expect(sentMessage).toMatchObject({
      id: expect.any(String),
      conversation_id: startedConversation.id,
      author_id: testUser.id,
      content: 'legacy shim message',
    });

    const [legacyMessage] = await db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.id, sentMessage.id))
      .limit(1);
    expect(legacyMessage).toBeUndefined();

    const [chatMessage] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, sentMessage.id))
      .limit(1);
    expect(chatMessage?.conversation_id).toBe(startedConversation.id);
    expect(chatMessage?.body_text).toBe('legacy shim message');

    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/conversations/${startedConversation.id}/messages?page=1&limit=20`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listResponse.statusCode).toBe(HTTP_STATUS.OK);
    const listed = JSON.parse(listResponse.body);
    expect(listed.items.length).toBeGreaterThanOrEqual(1);
    expect(listed.items[0]).toMatchObject({
      id: sentMessage.id,
      conversation_id: startedConversation.id,
      author_id: testUser.id,
      content: 'legacy shim message',
    });
    expect(Array.isArray(listed.items[0].attachments)).toBe(true);

    const readResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/conversations/${startedConversation.id}/read`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(readResponse.statusCode).toBe(HTTP_STATUS.OK);
    const readBody = JSON.parse(readResponse.body);
    expect(readBody.conversation_id).toBe(startedConversation.id);

    const [receipt] = await db
      .select()
      .from(schema.chatReceipts)
      .where(
        and(
          eq(schema.chatReceipts.conversation_id, startedConversation.id),
          eq(schema.chatReceipts.user_id, testUser.id)
        )
      )
      .limit(1);
    expect(receipt).toBeTruthy();
  });
});
