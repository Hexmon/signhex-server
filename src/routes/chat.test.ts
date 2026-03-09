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
import { hashPassword } from '@/auth/password';

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

async function issueTokenForUser(user: { id: string; email: string; roleId: string; roleName: string }) {
  const token = await generateAccessToken(user.id, user.email, user.roleId, user.roleName);
  await createSessionRepository().create({
    user_id: user.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

async function issueTokenWithSession(user: { id: string; email: string; roleId: string; roleName: string }) {
  const token = await generateAccessToken(user.id, user.email, user.roleId, user.roleName);
  await createSessionRepository().create({
    user_id: user.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token;
}

async function ensureRole(name: string) {
  const db = getDatabase();
  const [existing] = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(schema.roles)
    .values({
      id: randomUUID(),
      name,
      permissions: {},
      is_system: false,
    })
    .returning();
  return created;
}

describe('Chat Routes - lifecycle and tombstone safety', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    if (!(await tableExists('chat_conversations'))) {
      await applyMigrationFile('0008_chat_core.sql');
    }
    await applyMigrationFile('0011_notifications_payload_fields.sql');
    await applyMigrationFile('0010_chat_message_revisions.sql');
    await applyMigrationFile('0012_chat_dm_pair_active_unique.sql');
    await applyMigrationFile('0013_chat_fk_integrity.sql');
    await applyMigrationFile('0014_chat_pins_bookmarks_and_also_to_channel.sql');
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

    adminToken = await issueTokenForUser({
      id: testUser.id,
      email: testUser.email,
      roleId: adminRole.id,
      roleName: adminRole.name,
    });
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
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/conversations/${conversationId}/moderation`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          userId: secondUserId,
          action: 'MUTE',
          until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          reason: 'blocked moderation',
        },
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
        also_to_channel: true,
      },
    ]);

    const mediaId = randomUUID();
    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Tombstone Attachment',
      type: 'IMAGE',
      status: 'READY',
      created_by: testUser.id,
    });

    await db.insert(schema.chatAttachments).values({
      id: randomUUID(),
      message_id: replyMessageId,
      media_asset_id: mediaId,
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

  it('allows admin to mute/unmute and enforces muted write restrictions', async () => {
    const db = getDatabase();
    const conversationId = randomUUID();
    const messageId = randomUUID();

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'FORUM_OPEN',
      created_by: testUser.id,
      state: 'ACTIVE',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      title: 'Muted Forum',
      metadata: {},
      last_seq: 1,
    });

    await db.insert(schema.chatMessages).values({
      id: messageId,
      conversation_id: conversationId,
      seq: 1,
      sender_id: testUser.id,
      body_text: 'seed for moderation',
    });

    const mutedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const muteResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/moderation`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: testUser.id,
        action: 'MUTE',
        until: mutedUntil,
        reason: 'test mute',
      },
    });
    expect(muteResponse.statusCode).toBe(HTTP_STATUS.OK);
    const muteBody = JSON.parse(muteResponse.body);
    expect(muteBody.moderation.user_id).toBe(testUser.id);
    expect(muteBody.moderation.muted_until).toBeTruthy();

    const blockedCalls = await Promise.all([
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { text: 'muted send' },
      }),
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/messages/${messageId}/reactions`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { emoji: ':mute:', op: 'add' },
      }),
      server.inject({
        method: 'PATCH',
        url: `/api/v1/chat/messages/${messageId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { text: 'muted edit' },
      }),
      server.inject({
        method: 'DELETE',
        url: `/api/v1/chat/messages/${messageId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    ]);

    for (const response of blockedCalls) {
      expect(response.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CHAT_MUTED');
      expect(body.error.details?.muted_until).toBeTruthy();
    }

    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/messages?afterSeq=0&limit=10`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listResponse.statusCode).toBe(HTTP_STATUS.OK);

    const unmuteResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/moderation`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: testUser.id,
        action: 'UNMUTE',
      },
    });
    expect(unmuteResponse.statusCode).toBe(HTTP_STATUS.OK);

    const sendAfterUnmute = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'allowed after unmute' },
    });
    expect(sendAfterUnmute.statusCode).toBe(HTTP_STATUS.OK);
  });

  it('allows admin to ban/unban and enforces banned read/write restrictions', async () => {
    const db = getDatabase();
    const conversationId = randomUUID();

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'FORUM_OPEN',
      created_by: testUser.id,
      state: 'ACTIVE',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      title: 'Banned Forum',
      metadata: {},
      last_seq: 0,
    });

    const bannedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const banResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/moderation`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: testUser.id,
        action: 'BAN',
        until: bannedUntil,
        reason: 'test ban',
      },
    });
    expect(banResponse.statusCode).toBe(HTTP_STATUS.OK);

    const blockedCalls = await Promise.all([
      server.inject({
        method: 'GET',
        url: `/api/v1/chat/conversations/${conversationId}/messages?afterSeq=0&limit=10`,
        headers: { authorization: `Bearer ${adminToken}` },
      }),
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/conversations/${conversationId}/read`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { lastReadSeq: 0 },
      }),
      server.inject({
        method: 'POST',
        url: `/api/v1/chat/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { text: 'banned send' },
      }),
    ]);

    for (const response of blockedCalls) {
      expect(response.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('CHAT_BANNED');
      expect(body.error.details?.banned_until).toBeTruthy();
    }

    const unbanResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/moderation`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: testUser.id,
        action: 'UNBAN',
      },
    });
    expect(unbanResponse.statusCode).toBe(HTTP_STATUS.OK);

    const listAfterUnban = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/messages?afterSeq=0&limit=10`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listAfterUnban.statusCode).toBe(HTTP_STATUS.OK);
  });

  it('rejects revoked sessions on chat routes', async () => {
    const db = getDatabase();
    const [adminRole] = await db
      .select()
      .from(schema.roles)
      .where(eq(schema.roles.name, 'ADMIN'))
      .limit(1);
    if (!adminRole) throw new Error('ADMIN role is required');

    const issued = await issueTokenWithSession({
      id: testUser.id,
      email: testUser.email,
      roleId: adminRole.id,
      roleName: adminRole.name,
    });
    await createSessionRepository().revokeByJti(issued.jti);

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects messages with too many attachments', async () => {
    const db = getDatabase();
    const conversationId = randomUUID();

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'FORUM_OPEN',
      created_by: testUser.id,
      state: 'ACTIVE',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      title: 'Attachment Limit Forum',
      metadata: {},
      last_seq: 0,
    });

    const attachmentIds = Array.from({ length: 11 }, () => randomUUID());
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        text: 'too many attachments',
        attachmentMediaIds: attachmentIds,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('CHAT_TOO_MANY_ATTACHMENTS');
  });

  it('rejects non-ready media attachments', async () => {
    const db = getDatabase();
    const conversationId = randomUUID();
    const mediaId = randomUUID();

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'FORUM_OPEN',
      created_by: testUser.id,
      state: 'ACTIVE',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      title: 'Media Readiness Forum',
      metadata: {},
      last_seq: 0,
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Not Ready Media',
      type: 'IMAGE',
      status: 'PROCESSING',
      created_by: testUser.id,
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        text: 'media not ready',
        attachmentMediaIds: [mediaId],
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('MEDIA_NOT_READY');
  });

  it('recreates ACTIVE DM after hard delete and hides old deleted DM in list', async () => {
    const db = getDatabase();
    const operatorRole = await ensureRole('OPERATOR');
    const superAdminRole = await ensureRole('SUPER_ADMIN');

    const otherUserId = randomUUID();
    const otherUserEmail = `chat-dm-user-${Date.now()}@example.com`;
    const superAdminUserId = randomUUID();
    const superAdminEmail = `chat-super-${Date.now()}@example.com`;
    const passwordHash = await hashPassword('Password123!');

    await db.insert(schema.users).values({
      id: otherUserId,
      email: otherUserEmail,
      password_hash: passwordHash,
      first_name: 'Other',
      last_name: 'User',
      role_id: operatorRole.id,
      is_active: true,
    });

    await db.insert(schema.users).values({
      id: superAdminUserId,
      email: superAdminEmail,
      password_hash: passwordHash,
      first_name: 'Super',
      last_name: 'Admin',
      role_id: superAdminRole.id,
      is_active: true,
    });

    const otherUserToken = await issueTokenForUser({
      id: otherUserId,
      email: otherUserEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });
    const superAdminToken = await issueTokenForUser({
      id: superAdminUserId,
      email: superAdminEmail,
      roleId: superAdminRole.id,
      roleName: superAdminRole.name,
    });

    const firstDmResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/dm',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { otherUserId },
    });
    expect(firstDmResponse.statusCode).toBe(HTTP_STATUS.OK);
    const firstDm = JSON.parse(firstDmResponse.body).conversation;
    expect(firstDm.state).toBe('ACTIVE');

    const deleteDmResponse = await server.inject({
      method: 'DELETE',
      url: `/api/v1/chat/conversations/${firstDm.id}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(deleteDmResponse.statusCode).toBe(HTTP_STATUS.OK);

    const recreateDmResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/dm',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { otherUserId },
    });
    expect(recreateDmResponse.statusCode).toBe(HTTP_STATUS.OK);
    const recreatedDm = JSON.parse(recreateDmResponse.body).conversation;
    expect(recreatedDm.state).toBe('ACTIVE');
    expect(recreatedDm.id).not.toBe(firstDm.id);

    const sendResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${recreatedDm.id}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'hello recreated dm' },
    });
    expect(sendResponse.statusCode).toBe(HTTP_STATUS.OK);

    const otherUserReadResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${recreatedDm.id}/messages?afterSeq=0&limit=20`,
      headers: { authorization: `Bearer ${otherUserToken}` },
    });
    expect(otherUserReadResponse.statusCode).toBe(HTTP_STATUS.OK);
    const otherReadBody = JSON.parse(otherUserReadResponse.body);
    expect(otherReadBody.items.length).toBeGreaterThanOrEqual(1);

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listResponse.statusCode).toBe(HTTP_STATUS.OK);
    const listBody = JSON.parse(listResponse.body);
    const listedIds = listBody.items.map((item: { id: string }) => item.id);
    expect(listedIds).toContain(recreatedDm.id);
    expect(listedIds).not.toContain(firstDm.id);
  });

  it('purges pins and bookmarks on hard delete', async () => {
    const db = getDatabase();
    const superAdminRole = await ensureRole('SUPER_ADMIN');
    const superAdminUserId = randomUUID();
    const superAdminEmail = `chat-hard-delete-super-${Date.now()}@example.com`;

    await db.insert(schema.users).values({
      id: superAdminUserId,
      email: superAdminEmail,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Super',
      last_name: 'Delete',
      role_id: superAdminRole.id,
      is_active: true,
    });

    const superAdminToken = await issueTokenForUser({
      id: superAdminUserId,
      email: superAdminEmail,
      roleId: superAdminRole.id,
      roleName: superAdminRole.name,
    });

    const createConversation = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'GROUP_CLOSED',
        title: 'Hard Delete Purge Group',
      },
    });
    expect(createConversation.statusCode).toBe(HTTP_STATUS.OK);
    const conversationId = JSON.parse(createConversation.body).conversation.id as string;

    const sendMessage = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'message to pin and bookmark' },
    });
    expect(sendMessage.statusCode).toBe(HTTP_STATUS.OK);
    const messageId = JSON.parse(sendMessage.body).message.id as string;

    const pinResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/messages/${messageId}/pin`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pinResponse.statusCode).toBe(HTTP_STATUS.OK);

    const bookmarkResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/bookmarks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'LINK',
        label: 'Reference',
        url: 'https://example.com',
      },
    });
    expect(bookmarkResponse.statusCode).toBe(HTTP_STATUS.OK);

    const pinsBefore = await db
      .select()
      .from(schema.chatPins)
      .where(eq(schema.chatPins.conversation_id, conversationId));
    const bookmarksBefore = await db
      .select()
      .from(schema.chatBookmarks)
      .where(eq(schema.chatBookmarks.conversation_id, conversationId));
    expect(pinsBefore.length).toBeGreaterThan(0);
    expect(bookmarksBefore.length).toBeGreaterThan(0);

    const hardDelete = await server.inject({
      method: 'DELETE',
      url: `/api/v1/chat/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(hardDelete.statusCode).toBe(HTTP_STATUS.OK);

    const pinsAfter = await db
      .select()
      .from(schema.chatPins)
      .where(eq(schema.chatPins.conversation_id, conversationId));
    const bookmarksAfter = await db
      .select()
      .from(schema.chatBookmarks)
      .where(eq(schema.chatBookmarks.conversation_id, conversationId));
    expect(pinsAfter.length).toBe(0);
    expect(bookmarksAfter.length).toBe(0);
  });

  it('enforces special mention policy for @everyone/@channel and allows admin', async () => {
    const db = getDatabase();
    const operatorRole = await ensureRole('OPERATOR');
    const operatorUserId = randomUUID();
    const operatorEmail = `chat-mention-op-${Date.now()}@example.com`;
    const passwordHash = await hashPassword('Password123!');

    await db.insert(schema.users).values({
      id: operatorUserId,
      email: operatorEmail,
      password_hash: passwordHash,
      first_name: 'Mention',
      last_name: 'Operator',
      role_id: operatorRole.id,
      is_active: true,
    });

    const operatorToken = await issueTokenForUser({
      id: operatorUserId,
      email: operatorEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });

    const createConversation = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'FORUM_OPEN',
        title: 'Mention Policy Forum',
      },
    });
    expect(createConversation.statusCode).toBe(HTTP_STATUS.OK);
    const conversationId = JSON.parse(createConversation.body).conversation.id as string;

    const operatorEveryone = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: '@everyone hello team' },
    });
    expect(operatorEveryone.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(JSON.parse(operatorEveryone.body).error.code).toBe('CHAT_MENTION_POLICY_VIOLATION');

    const operatorNormal = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'normal operator message' },
    });
    expect(operatorNormal.statusCode).toBe(HTTP_STATUS.OK);
    const operatorMessageId = JSON.parse(operatorNormal.body).message.id as string;

    const operatorEditEveryone = await server.inject({
      method: 'PATCH',
      url: `/api/v1/chat/messages/${operatorMessageId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: '@everyone edited mention' },
    });
    expect(operatorEditEveryone.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(JSON.parse(operatorEditEveryone.body).error.code).toBe('CHAT_MENTION_POLICY_VIOLATION');

    const adminEveryone = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: '@everyone hello from admin' },
    });
    expect(adminEveryone.statusCode).toBe(HTTP_STATUS.OK);
  });

  it('enforces edit/delete message policies from conversation settings', async () => {
    const db = getDatabase();
    const operatorRole = await ensureRole('OPERATOR');
    const operatorUserId = randomUUID();
    const operatorEmail = `chat-policy-op-${Date.now()}@example.com`;
    const passwordHash = await hashPassword('Password123!');

    await db.insert(schema.users).values({
      id: operatorUserId,
      email: operatorEmail,
      password_hash: passwordHash,
      first_name: 'Policy',
      last_name: 'Operator',
      role_id: operatorRole.id,
      is_active: true,
    });

    const operatorToken = await issueTokenForUser({
      id: operatorUserId,
      email: operatorEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });

    const createConversation = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'GROUP_CLOSED',
        title: 'Policy Group',
        members: [operatorUserId],
      },
    });
    expect(createConversation.statusCode).toBe(HTTP_STATUS.OK);
    const conversationId = JSON.parse(createConversation.body).conversation.id as string;

    const operatorSend = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { text: 'operator message' },
    });
    expect(operatorSend.statusCode).toBe(HTTP_STATUS.OK);
    const operatorMessageId = JSON.parse(operatorSend.body).message.id as string;

    const adminEditBeforePolicyUpdate = await server.inject({
      method: 'PATCH',
      url: `/api/v1/chat/messages/${operatorMessageId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'admin edit should fail under OWN' },
    });
    expect(adminEditBeforePolicyUpdate.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(JSON.parse(adminEditBeforePolicyUpdate.body).error.code).toBe('CHAT_EDIT_POLICY_FORBIDDEN');

    const updateConversation = await server.inject({
      method: 'PATCH',
      url: `/api/v1/chat/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        settings: {
          edit_policy: 'ADMINS_ONLY',
          delete_policy: 'DISABLED',
        },
      },
    });
    expect(updateConversation.statusCode).toBe(HTTP_STATUS.OK);

    const adminEditAfterPolicyUpdate = await server.inject({
      method: 'PATCH',
      url: `/api/v1/chat/messages/${operatorMessageId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'admin edit allowed now' },
    });
    expect(adminEditAfterPolicyUpdate.statusCode).toBe(HTTP_STATUS.OK);

    const operatorDeleteDisabled = await server.inject({
      method: 'DELETE',
      url: `/api/v1/chat/messages/${operatorMessageId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(operatorDeleteDisabled.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(JSON.parse(operatorDeleteDisabled.body).error.code).toBe('CHAT_DELETE_POLICY_DISABLED');
  });

  it('supports thread alsoToChannel visibility behavior', async () => {
    const createConversation = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'GROUP_CLOSED',
        title: 'Thread Visibility Group',
      },
    });
    expect(createConversation.statusCode).toBe(HTTP_STATUS.OK);
    const conversationId = JSON.parse(createConversation.body).conversation.id as string;

    const rootMessage = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'root message' },
    });
    expect(rootMessage.statusCode).toBe(HTTP_STATUS.OK);
    const rootId = JSON.parse(rootMessage.body).message.id as string;

    const hiddenReply = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        text: 'thread reply hidden from channel',
        replyTo: rootId,
        alsoToChannel: false,
      },
    });
    expect(hiddenReply.statusCode).toBe(HTTP_STATUS.OK);
    const hiddenReplyId = JSON.parse(hiddenReply.body).message.id as string;

    const channelList = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/messages?afterSeq=0&limit=20`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(channelList.statusCode).toBe(HTTP_STATUS.OK);
    const channelItems = JSON.parse(channelList.body).items as Array<{ id: string }>;
    expect(channelItems.some((item) => item.id === hiddenReplyId)).toBe(false);

    const threadList = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/thread/${rootId}?afterSeq=0&limit=20`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(threadList.statusCode).toBe(HTTP_STATUS.OK);
    const threadItems = JSON.parse(threadList.body).items as Array<{ id: string }>;
    expect(threadItems.some((item) => item.id === hiddenReplyId)).toBe(true);

    const visibleReply = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        text: 'thread reply visible in channel',
        replyTo: rootId,
        alsoToChannel: true,
      },
    });
    expect(visibleReply.statusCode).toBe(HTTP_STATUS.OK);
    const visibleReplyId = JSON.parse(visibleReply.body).message.id as string;

    const channelListAfterVisibleReply = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/messages?afterSeq=0&limit=50`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(channelListAfterVisibleReply.statusCode).toBe(HTTP_STATUS.OK);
    const channelItemsAfter = JSON.parse(channelListAfterVisibleReply.body).items as Array<{ id: string }>;
    expect(channelItemsAfter.some((item) => item.id === visibleReplyId)).toBe(true);
  });

  it('supports pin/unpin and bookmark CRUD', async () => {
    const createConversation = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'GROUP_CLOSED',
        title: 'Pins and Bookmarks Group',
      },
    });
    expect(createConversation.statusCode).toBe(HTTP_STATUS.OK);
    const conversationId = JSON.parse(createConversation.body).conversation.id as string;

    const sendMessage = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'pin me' },
    });
    expect(sendMessage.statusCode).toBe(HTTP_STATUS.OK);
    const messageId = JSON.parse(sendMessage.body).message.id as string;

    const pinResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/messages/${messageId}/pin`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pinResponse.statusCode).toBe(HTTP_STATUS.OK);

    const listPins = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/pins`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listPins.statusCode).toBe(HTTP_STATUS.OK);
    const pinsBody = JSON.parse(listPins.body);
    expect(pinsBody.items.some((item: { message_id: string }) => item.message_id === messageId)).toBe(true);

    const unpinResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/messages/${messageId}/unpin`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(unpinResponse.statusCode).toBe(HTTP_STATUS.OK);

    const createBookmark = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/bookmarks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'MESSAGE',
        label: 'Important message',
        messageId,
      },
    });
    expect(createBookmark.statusCode).toBe(HTTP_STATUS.OK);
    const bookmarkId = JSON.parse(createBookmark.body).bookmark.id as string;
    const createBookmarkAgain = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/bookmarks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'MESSAGE',
        label: 'Important message duplicate',
        messageId,
      },
    });
    expect(createBookmarkAgain.statusCode).toBe(HTTP_STATUS.OK);
    const bookmarkIdAgain = JSON.parse(createBookmarkAgain.body).bookmark.id as string;
    expect(bookmarkIdAgain).toBe(bookmarkId);

    const listBookmarks = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/bookmarks`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listBookmarks.statusCode).toBe(HTTP_STATUS.OK);
    const bookmarksBody = JSON.parse(listBookmarks.body);
    expect(bookmarksBody.items.some((item: { id: string }) => item.id === bookmarkId)).toBe(true);
    const messageBookmarks = bookmarksBody.items.filter(
      (item: { type: string; message_id: string | null }) =>
        item.type === 'MESSAGE' && item.message_id === messageId
    );
    expect(messageBookmarks.length).toBe(1);

    const deleteBookmark = await server.inject({
      method: 'DELETE',
      url: `/api/v1/chat/bookmarks/${bookmarkId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleteBookmark.statusCode).toBe(HTTP_STATUS.OK);

    const archiveConversation = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/archive`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(archiveConversation.statusCode).toBe(HTTP_STATUS.OK);

    const pinWhenArchived = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/messages/${messageId}/pin`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pinWhenArchived.statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(JSON.parse(pinWhenArchived.body).error.code).toBe('CHAT_ARCHIVED');

    const bookmarkWhenArchived = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/bookmarks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'MESSAGE',
        label: 'Should not work',
        messageId,
      },
    });
    expect(bookmarkWhenArchived.statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(JSON.parse(bookmarkWhenArchived.body).error.code).toBe('CHAT_ARCHIVED');
  });

  it('enforces deep-link resolve/share access rules for DM and closed groups', async () => {
    const db = getDatabase();
    const operatorRole = await ensureRole('OPERATOR');
    const adminRole = await ensureRole('ADMIN');

    const dmOtherUserId = randomUUID();
    const dmOtherUserEmail = `chat-deeplink-dm-${Date.now()}@example.com`;
    const outsiderAdminId = randomUUID();
    const outsiderAdminEmail = `chat-deeplink-outsider-${Date.now()}@example.com`;
    const groupMemberId = randomUUID();
    const groupMemberEmail = `chat-deeplink-group-member-${Date.now()}@example.com`;
    const groupOutsiderId = randomUUID();
    const groupOutsiderEmail = `chat-deeplink-group-outsider-${Date.now()}@example.com`;
    const passwordHash = await hashPassword('Password123!');

    await db.insert(schema.users).values([
      {
        id: dmOtherUserId,
        email: dmOtherUserEmail,
        password_hash: passwordHash,
        first_name: 'DM',
        last_name: 'Participant',
        role_id: operatorRole.id,
        is_active: true,
      },
      {
        id: outsiderAdminId,
        email: outsiderAdminEmail,
        password_hash: passwordHash,
        first_name: 'Outsider',
        last_name: 'Admin',
        role_id: adminRole.id,
        is_active: true,
      },
      {
        id: groupMemberId,
        email: groupMemberEmail,
        password_hash: passwordHash,
        first_name: 'Group',
        last_name: 'Member',
        role_id: operatorRole.id,
        is_active: true,
      },
      {
        id: groupOutsiderId,
        email: groupOutsiderEmail,
        password_hash: passwordHash,
        first_name: 'Group',
        last_name: 'Outsider',
        role_id: operatorRole.id,
        is_active: true,
      },
    ]);

    const dmOtherToken = await issueTokenForUser({
      id: dmOtherUserId,
      email: dmOtherUserEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });
    const outsiderAdminToken = await issueTokenForUser({
      id: outsiderAdminId,
      email: outsiderAdminEmail,
      roleId: adminRole.id,
      roleName: adminRole.name,
    });
    const groupMemberToken = await issueTokenForUser({
      id: groupMemberId,
      email: groupMemberEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });
    const groupOutsiderToken = await issueTokenForUser({
      id: groupOutsiderId,
      email: groupOutsiderEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });

    const createDm = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/dm',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { otherUserId: dmOtherUserId },
    });
    expect(createDm.statusCode).toBe(HTTP_STATUS.OK);
    const dmConversationId = JSON.parse(createDm.body).conversation.id as string;

    const dmResolveAllowed = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${dmConversationId}`,
      headers: { authorization: `Bearer ${dmOtherToken}` },
    });
    expect(dmResolveAllowed.statusCode).toBe(HTTP_STATUS.OK);
    const dmResolveAllowedBody = JSON.parse(dmResolveAllowed.body);
    expect(dmResolveAllowedBody.viewer.is_member).toBe(true);

    const dmShareAllowed = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${dmConversationId}/share-link`,
      headers: { authorization: `Bearer ${dmOtherToken}` },
    });
    expect(dmShareAllowed.statusCode).toBe(HTTP_STATUS.OK);
    const dmShareBody = JSON.parse(dmShareAllowed.body);
    expect(dmShareBody.path).toBe(`/chat/${dmConversationId}`);
    if (typeof dmShareBody.url === 'string') {
      expect(dmShareBody.url.endsWith(`/chat/${dmConversationId}`)).toBe(true);
    }

    const dmResolveForbidden = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${dmConversationId}`,
      headers: { authorization: `Bearer ${outsiderAdminToken}` },
    });
    expect(dmResolveForbidden.statusCode).toBe(HTTP_STATUS.FORBIDDEN);

    const dmShareForbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${dmConversationId}/share-link`,
      headers: { authorization: `Bearer ${outsiderAdminToken}` },
    });
    expect(dmShareForbidden.statusCode).toBe(HTTP_STATUS.FORBIDDEN);

    const createGroup = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'GROUP_CLOSED',
        title: 'Deep Link Group',
        members: [groupMemberId],
        invite_policy: 'ADMINS_ONLY_CAN_INVITE',
      },
    });
    expect(createGroup.statusCode).toBe(HTTP_STATUS.OK);
    const groupConversation = JSON.parse(createGroup.body).conversation as {
      id: string;
      invite_policy: string;
    };

    const groupResolveForbidden = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${groupConversation.id}`,
      headers: { authorization: `Bearer ${groupOutsiderToken}` },
    });
    expect(groupResolveForbidden.statusCode).toBe(HTTP_STATUS.FORBIDDEN);

    const groupShareForbidden = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${groupConversation.id}/share-link`,
      headers: { authorization: `Bearer ${groupOutsiderToken}` },
    });
    expect(groupShareForbidden.statusCode).toBe(HTTP_STATUS.FORBIDDEN);

    const [memberCountBefore] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.chatMembers)
      .where(eq(schema.chatMembers.conversation_id, groupConversation.id));
    const [groupBefore] = await db
      .select({ invite_policy: schema.chatConversations.invite_policy })
      .from(schema.chatConversations)
      .where(eq(schema.chatConversations.id, groupConversation.id));

    const groupResolveAllowed = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${groupConversation.id}`,
      headers: { authorization: `Bearer ${groupMemberToken}` },
    });
    expect(groupResolveAllowed.statusCode).toBe(HTTP_STATUS.OK);
    const groupResolveBody = JSON.parse(groupResolveAllowed.body);
    expect(groupResolveBody.viewer.is_member).toBe(true);
    expect(groupResolveBody.viewer.role).toBe('MEMBER');

    const groupShareAllowed = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${groupConversation.id}/share-link`,
      headers: { authorization: `Bearer ${groupMemberToken}` },
    });
    expect(groupShareAllowed.statusCode).toBe(HTTP_STATUS.OK);
    const groupShareBody = JSON.parse(groupShareAllowed.body);
    expect(groupShareBody.path).toBe(`/chat/${groupConversation.id}`);

    const [memberCountAfter] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.chatMembers)
      .where(eq(schema.chatMembers.conversation_id, groupConversation.id));
    const [groupAfter] = await db
      .select({ invite_policy: schema.chatConversations.invite_policy })
      .from(schema.chatConversations)
      .where(eq(schema.chatConversations.id, groupConversation.id));

    expect(Number(memberCountAfter.count)).toBe(Number(memberCountBefore.count));
    expect(groupAfter?.invite_policy).toBe(groupBefore?.invite_policy);
  });

  it('supports deep-link resolve/share for forum users and blocks banned users', async () => {
    const db = getDatabase();
    const operatorRole = await ensureRole('OPERATOR');

    const forumUserId = randomUUID();
    const forumUserEmail = `chat-forum-link-${Date.now()}@example.com`;
    const bannedUserId = randomUUID();
    const bannedUserEmail = `chat-forum-link-banned-${Date.now()}@example.com`;
    const passwordHash = await hashPassword('Password123!');

    await db.insert(schema.users).values([
      {
        id: forumUserId,
        email: forumUserEmail,
        password_hash: passwordHash,
        first_name: 'Forum',
        last_name: 'Viewer',
        role_id: operatorRole.id,
        is_active: true,
      },
      {
        id: bannedUserId,
        email: bannedUserEmail,
        password_hash: passwordHash,
        first_name: 'Forum',
        last_name: 'Banned',
        role_id: operatorRole.id,
        is_active: true,
      },
    ]);

    const forumUserToken = await issueTokenForUser({
      id: forumUserId,
      email: forumUserEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });
    const bannedUserToken = await issueTokenForUser({
      id: bannedUserId,
      email: bannedUserEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });

    const createForum = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'FORUM_OPEN',
        title: 'Deep Link Forum',
      },
    });
    expect(createForum.statusCode).toBe(HTTP_STATUS.OK);
    const forumConversationId = JSON.parse(createForum.body).conversation.id as string;

    const forumResolveAllowed = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${forumConversationId}`,
      headers: { authorization: `Bearer ${forumUserToken}` },
    });
    expect(forumResolveAllowed.statusCode).toBe(HTTP_STATUS.OK);
    const forumResolveBody = JSON.parse(forumResolveAllowed.body);
    expect(forumResolveBody.viewer.is_member).toBe(false);
    expect(forumResolveBody.viewer.role).toBeNull();

    const forumShareAllowed = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${forumConversationId}/share-link`,
      headers: { authorization: `Bearer ${forumUserToken}` },
    });
    expect(forumShareAllowed.statusCode).toBe(HTTP_STATUS.OK);

    const banUser = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${forumConversationId}/moderation`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        userId: bannedUserId,
        action: 'BAN',
        until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        reason: 'deep-link ban test',
      },
    });
    expect(banUser.statusCode).toBe(HTTP_STATUS.OK);

    const bannedResolve = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${forumConversationId}`,
      headers: { authorization: `Bearer ${bannedUserToken}` },
    });
    expect(bannedResolve.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(JSON.parse(bannedResolve.body).error.code).toBe('CHAT_BANNED');

    const bannedShare = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${forumConversationId}/share-link`,
      headers: { authorization: `Bearer ${bannedUserToken}` },
    });
    expect(bannedShare.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(JSON.parse(bannedShare.body).error.code).toBe('CHAT_BANNED');
  });

  it('allows deep-link resolve/share for archived and returns not found for deleted conversations', async () => {
    const db = getDatabase();
    const superAdminRole = await ensureRole('SUPER_ADMIN');
    const superAdminId = randomUUID();
    const superAdminEmail = `chat-link-superadmin-${Date.now()}@example.com`;

    await db.insert(schema.users).values({
      id: superAdminId,
      email: superAdminEmail,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Super',
      last_name: 'Admin',
      role_id: superAdminRole.id,
      is_active: true,
    });

    const superAdminToken = await issueTokenForUser({
      id: superAdminId,
      email: superAdminEmail,
      roleId: superAdminRole.id,
      roleName: superAdminRole.name,
    });

    const createGroup = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        type: 'GROUP_CLOSED',
        title: 'Archived/Deleted Link Group',
      },
    });
    expect(createGroup.statusCode).toBe(HTTP_STATUS.OK);
    const conversationId = JSON.parse(createGroup.body).conversation.id as string;

    const archiveResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/archive`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(archiveResponse.statusCode).toBe(HTTP_STATUS.OK);

    const archivedResolve = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(archivedResolve.statusCode).toBe(HTTP_STATUS.OK);
    expect(JSON.parse(archivedResolve.body).conversation.state).toBe('ARCHIVED');

    const archivedShare = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/share-link`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(archivedShare.statusCode).toBe(HTTP_STATUS.OK);

    const archivedSend = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { text: 'should fail because archived' },
    });
    expect(archivedSend.statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(JSON.parse(archivedSend.body).error.code).toBe('CHAT_ARCHIVED');

    const hardDelete = await server.inject({
      method: 'DELETE',
      url: `/api/v1/chat/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${superAdminToken}` },
    });
    expect(hardDelete.statusCode).toBe(HTTP_STATUS.OK);

    const deletedResolve = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deletedResolve.statusCode).toBe(HTTP_STATUS.NOT_FOUND);

    const deletedShare = await server.inject({
      method: 'POST',
      url: `/api/v1/chat/conversations/${conversationId}/share-link`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deletedShare.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
  });

  it('enforces DM confidentiality for non-participant admins', async () => {
    const db = getDatabase();
    const operatorRole = await ensureRole('OPERATOR');
    const adminRole = await ensureRole('ADMIN');

    const participantUserId = randomUUID();
    const participantEmail = `chat-dm-participant-${Date.now()}@example.com`;
    const outsiderAdminId = randomUUID();
    const outsiderAdminEmail = `chat-dm-outsider-${Date.now()}@example.com`;
    const passwordHash = await hashPassword('Password123!');

    await db.insert(schema.users).values({
      id: participantUserId,
      email: participantEmail,
      password_hash: passwordHash,
      first_name: 'Participant',
      last_name: 'User',
      role_id: operatorRole.id,
      is_active: true,
    });

    await db.insert(schema.users).values({
      id: outsiderAdminId,
      email: outsiderAdminEmail,
      password_hash: passwordHash,
      first_name: 'Outsider',
      last_name: 'Admin',
      role_id: adminRole.id,
      is_active: true,
    });

    const participantToken = await issueTokenForUser({
      id: participantUserId,
      email: participantEmail,
      roleId: operatorRole.id,
      roleName: operatorRole.name,
    });
    const outsiderAdminToken = await issueTokenForUser({
      id: outsiderAdminId,
      email: outsiderAdminEmail,
      roleId: adminRole.id,
      roleName: adminRole.name,
    });

    const dmResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/dm',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { otherUserId: participantUserId },
    });
    expect(dmResponse.statusCode).toBe(HTTP_STATUS.OK);
    const dmConversation = JSON.parse(dmResponse.body).conversation;

    const participantReadResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${dmConversation.id}/messages?afterSeq=0&limit=20`,
      headers: { authorization: `Bearer ${participantToken}` },
    });
    expect(participantReadResponse.statusCode).toBe(HTTP_STATUS.OK);

    const outsiderReadResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${dmConversation.id}/messages?afterSeq=0&limit=20`,
      headers: { authorization: `Bearer ${outsiderAdminToken}` },
    });
    expect(outsiderReadResponse.statusCode).toBe(HTTP_STATUS.FORBIDDEN);

    const outsiderListResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/chat/conversations',
      headers: { authorization: `Bearer ${outsiderAdminToken}` },
    });
    expect(outsiderListResponse.statusCode).toBe(HTTP_STATUS.OK);
    const outsiderList = JSON.parse(outsiderListResponse.body);
    const outsiderConversationIds = outsiderList.items.map((item: { id: string }) => item.id);
    expect(outsiderConversationIds).not.toContain(dmConversation.id);
  });
});
