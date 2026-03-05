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
