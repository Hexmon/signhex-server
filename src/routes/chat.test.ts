import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeTestServer, createTestServer, testUser } from '@/test/helpers';
import { getDatabase, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { HTTP_STATUS } from '@/http-status-codes';
import { sql } from 'drizzle-orm';
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
    await db.execute(sql.raw(statement));
  }
}

describe('Chat Routes - lifecycle and tombstone safety', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    await applyMigrationFile('0008_chat_core.sql');
    await applyMigrationFile('0010_chat_message_revisions.sql');
    const db = getDatabase();
    const [adminRole] = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.name, 'ADMIN'))
      .limit(1);

    if (!adminRole) {
      throw new Error('ADMIN role is required for chat route tests');
    }

    await db
      .update(schema.users)
      .set({ role_id: adminRole.id })
      .where(eq(schema.users.id, testUser.id));

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
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('blocks mutating operations when conversation is archived but allows read/list', async () => {
    const db = getDatabase();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const secondUserId = randomUUID();

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'GROUP_CLOSED',
      created_by: testUser.id,
      state: 'ARCHIVED',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      title: 'Archived Group',
      metadata: {},
      last_seq: 1,
    });

    await db.insert(schema.chatMembers).values({
      conversation_id: conversationId,
      user_id: testUser.id,
      role: 'OWNER',
      is_system: false,
    });

    await db.insert(schema.chatMessages).values({
      id: messageId,
      conversation_id: conversationId,
      seq: 1,
      sender_id: testUser.id,
      body_text: 'seed message',
    });

    const readResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/messages?afterSeq=0&limit=20`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(readResponse.statusCode).toBe(HTTP_STATUS.OK);

    const markReadResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/read`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        lastReadSeq: 1,
      },
    });
    expect(markReadResponse.statusCode).toBe(HTTP_STATUS.OK);

    const mutatingCalls = [
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { text: 'blocked send' },
      }),
      server.inject({
        method: 'PATCH',
        url: `/api/v1/chat/messages/${messageId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { text: 'blocked edit' },
      }),
      server.inject({
        method: 'DELETE',
        url: `/api/v1/chat/messages/${messageId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      }),
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/messages/${messageId}/reactions`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { emoji: ':thumbsup:', op: 'add' },
      }),
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/conversations/${conversationId}/invite`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { userIds: [secondUserId] },
      }),
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/conversations/${conversationId}/members/remove`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { userId: secondUserId },
      }),
      server.inject({
        method: 'PATCH',
        url: `/api/v1/chat/conversations/${conversationId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { title: 'blocked update' },
      }),
    ];

    const results = await Promise.all(mutatingCalls);
    for (const response of results) {
      expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CHAT_ARCHIVED');
    }
  });

  it('returns tombstone-safe payload for deleted messages in list and thread', async () => {
    const db = getDatabase();
    const conversationId = randomUUID();
    const rootMessageId = randomUUID();
    const replyMessageId = randomUUID();

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'GROUP_CLOSED',
      created_by: testUser.id,
      state: 'ACTIVE',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      title: 'Tombstone Group',
      metadata: {},
      last_seq: 2,
    });

    await db.insert(schema.chatMembers).values({
      conversation_id: conversationId,
      user_id: testUser.id,
      role: 'OWNER',
      is_system: false,
    });

    await db.insert(schema.chatMessages).values([
      {
        id: rootMessageId,
        conversation_id: conversationId,
        seq: 1,
        sender_id: testUser.id,
        body_text: 'root',
      },
      {
        id: replyMessageId,
        conversation_id: conversationId,
        seq: 2,
        sender_id: testUser.id,
        body_text: 'reply with attachment',
        body_rich: { mentions: [randomUUID()] },
        reply_to_message_id: rootMessageId,
        thread_root_id: rootMessageId,
      },
    ]);

    await db.insert(schema.chatAttachments).values({
      id: randomUUID(),
      message_id: replyMessageId,
      media_asset_id: randomUUID(),
      ord: 0,
    });

    await db.insert(schema.chatReactions).values({
      id: randomUUID(),
      message_id: replyMessageId,
      user_id: testUser.id,
      emoji: ':wave:',
    });

    const deleteResponse = await server.inject({
      method: 'DELETE',
      url: `/api/v1/chat/messages/${replyMessageId}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(deleteResponse.statusCode).toBe(HTTP_STATUS.OK);

    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/messages?afterSeq=0&limit=20`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(listResponse.statusCode).toBe(HTTP_STATUS.OK);
    const listBody = JSON.parse(listResponse.body);
    const listDeletedMessage = listBody.items.find((item: { id: string }) => item.id === replyMessageId);
    expect(listDeletedMessage).toBeTruthy();
    expect(listDeletedMessage.body_text).toBeNull();
    expect(listDeletedMessage.body_rich).toBeNull();
    expect(listDeletedMessage.attachments).toEqual([]);
    expect(listDeletedMessage.reactions).toEqual([]);
    expect(listDeletedMessage.deleted_at).toBeTruthy();

    const threadResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/thread/${rootMessageId}?afterSeq=0&limit=20`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(threadResponse.statusCode).toBe(HTTP_STATUS.OK);
    const threadBody = JSON.parse(threadResponse.body);
    const threadDeletedMessage = threadBody.items.find((item: { id: string }) => item.id === replyMessageId);
    expect(threadDeletedMessage).toBeTruthy();
    expect(threadDeletedMessage.body_text).toBeNull();
    expect(threadDeletedMessage.body_rich).toBeNull();
    expect(threadDeletedMessage.attachments).toEqual([]);
    expect(threadDeletedMessage.reactions).toEqual([]);

    const revisions = await db
      .select()
      .from(schema.chatMessageRevisions)
      .where(eq(schema.chatMessageRevisions.message_id, replyMessageId));
    expect(revisions.length).toBe(1);
    expect(revisions[0].action).toBe('DELETE');
  });
});
