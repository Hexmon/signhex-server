#!/usr/bin/env tsx

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { io as createSocketClient, type Socket } from 'socket.io-client';
import { initializeDatabase, closeDatabase, getDatabase, schema } from '../src/db/index.js';
import { createServer } from '../src/server/index.js';
import { generateAccessToken } from '../src/auth/jwt.js';
import { createSessionRepository } from '../src/db/repositories/session.js';
import { hashPassword } from '../src/auth/password.js';

type Role = typeof schema.roles.$inferSelect;
type User = typeof schema.users.$inferSelect;

type Actor = {
  user: User;
  role: Role;
  token: string;
};

type ApiResult = {
  status: number;
  data: unknown;
};

type Step = {
  name: string;
  ok: boolean;
  details?: string;
};

const steps: Step[] = [];

function recordStep(name: string, ok: boolean, details?: string) {
  steps.push({ name, ok, details });
  const prefix = ok ? 'OK' : 'FAIL';
  const suffix = details ? ` - ${details}` : '';
  console.log(`[${prefix}] ${name}${suffix}`);
}

async function ensureRole(name: string): Promise<Role> {
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

async function createUser(email: string, roleId: string): Promise<User> {
  const db = getDatabase();
  const [created] = await db
    .insert(schema.users)
    .values({
      id: randomUUID(),
      email,
      password_hash: await hashPassword('Password123!'),
      first_name: 'Chat',
      last_name: 'DryRun',
      role_id: roleId,
      is_active: true,
    })
    .returning();

  return created;
}

async function issueActor(user: User, role: Role): Promise<Actor> {
  const sessionRepo = createSessionRepository();
  const issued = await generateAccessToken(user.id, user.email, role.id, role.name);
  await sessionRepo.create({
    user_id: user.id,
    access_jti: issued.jti,
    expires_at: issued.expiresAt,
  });
  return { user, role, token: issued.token };
}

async function apiRequest(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();
  let data: unknown = raw;
  if (raw && contentType.includes('application/json')) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  } else if (!raw) {
    data = null;
  }

  return { status: response.status, data };
}

function assertStatus(
  stepName: string,
  result: ApiResult,
  expected: number | number[],
  details?: string
) {
  const expectedList = Array.isArray(expected) ? expected : [expected];
  const ok = expectedList.includes(result.status);
  recordStep(stepName, ok, details ?? `status=${result.status}`);
  if (!ok) {
    throw new Error(`${stepName} expected ${expectedList.join('/')} but got ${result.status}: ${JSON.stringify(result.data)}`);
  }
}

function requireObject(value: unknown, stepName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`${stepName} returned invalid payload`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length) {
    throw new Error(`Expected string field: ${field}`);
  }
  return value;
}

function connectSocket(baseUrl: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocketClient(`${baseUrl}/chat`, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 8000,
    });

    const onConnect = () => {
      cleanup();
      resolve(socket);
    };

    const onError = (error: Error) => {
      cleanup();
      socket.close();
      reject(error);
    };

    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
  });
}

async function subscribeSocket(socket: Socket, conversationId: string): Promise<{ subscribed: string[]; rejected: string[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Socket subscribe ack timed out'));
    }, 8000);

    socket.emit('chat:subscribe', { conversationIds: [conversationId] }, (result: unknown) => {
      clearTimeout(timeout);
      const payload = requireObject(result, 'socket subscribe');
      resolve({
        subscribed: Array.isArray(payload.subscribed) ? (payload.subscribed as string[]) : [],
        rejected: Array.isArray(payload.rejected) ? (payload.rejected as string[]) : [],
      });
    });
  });
}

async function waitForSocketEvent(
  socket: Socket,
  event: string,
  predicate: (payload: Record<string, unknown>) => boolean,
  timeoutMs = 8000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    const onEvent = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const p = payload as Record<string, unknown>;
      if (!predicate(p)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(p);
    };

    socket.on(event, onEvent);
  });
}

async function run() {
  let adminSocket: Socket | null = null;
  let memberSocket: Socket | null = null;
  let fastify: Awaited<ReturnType<typeof createServer>> | null = null;

  await initializeDatabase();

  try {
    fastify = await createServer();
    const baseUrl = await fastify.listen({ host: '127.0.0.1', port: 0 });
    recordStep('Server boot', true, baseUrl);

    const adminRole = await ensureRole('ADMIN');
    const superRole = await ensureRole('SUPER_ADMIN');
    const operatorRole = await ensureRole('OPERATOR');
    recordStep('Role setup', true);

    const suffix = Date.now();
    const adminUser = await createUser(`chat-dry-admin-${suffix}@example.com`, adminRole.id);
    const memberUser = await createUser(`chat-dry-member-${suffix}@example.com`, operatorRole.id);
    const superUser = await createUser(`chat-dry-super-${suffix}@example.com`, superRole.id);

    const admin = await issueActor(adminUser, adminRole);
    const member = await issueActor(memberUser, operatorRole);
    const superAdmin = await issueActor(superUser, superRole);
    recordStep('User/token setup', true);

    const dmResult = await apiRequest(baseUrl, admin.token, 'POST', '/api/v1/chat/dm', {
      otherUserId: member.user.id,
    });
    assertStatus('Create DM', dmResult, 200);
    const dmPayload = requireObject(dmResult.data, 'Create DM');
    const dmConversation = requireObject(dmPayload.conversation, 'Create DM conversation');
    const dmId = requireString(dmConversation.id, 'conversation.id');

    adminSocket = await connectSocket(baseUrl, admin.token);
    memberSocket = await connectSocket(baseUrl, member.token);
    recordStep('WS connect (admin/member)', true);

    const adminSub = await subscribeSocket(adminSocket, dmId);
    const memberSub = await subscribeSocket(memberSocket, dmId);
    const dmSubscribed = adminSub.subscribed.includes(dmId) && memberSub.subscribed.includes(dmId);
    recordStep('WS subscribe DM', dmSubscribed);
    if (!dmSubscribed) throw new Error(`Failed DM subscription: ${JSON.stringify({ adminSub, memberSub })}`);

    const wsMessagePromise = waitForSocketEvent(
      memberSocket,
      'chat:message:new',
      (payload) =>
        payload.conversationId === dmId && typeof payload.message === 'object' && payload.message !== null
    );

    const dmSend = await apiRequest(baseUrl, admin.token, 'POST', `/api/v1/chat/conversations/${dmId}/messages`, {
      text: 'hello from admin',
    });
    assertStatus('DM send', dmSend, 200);
    const dmSendPayload = requireObject(dmSend.data, 'DM send');
    const dmMessage = requireObject(dmSendPayload.message, 'DM send message');
    const firstMessageId = requireString(dmMessage.id, 'message.id');

    const wsMessageEvent = await wsMessagePromise;
    const wsMessage = requireObject(wsMessageEvent.message, 'WS chat:message:new message');
    const wsMessageIdOk = wsMessage.id === firstMessageId;
    recordStep('WS payload matches created message', wsMessageIdOk);
    if (!wsMessageIdOk) {
      throw new Error(`WS message id mismatch: expected ${firstMessageId}, got ${String(wsMessage.id)}`);
    }

    recordStep('WS fanout chat:message:new', Boolean(wsMessageEvent));

    const replyResult = await apiRequest(baseUrl, member.token, 'POST', `/api/v1/chat/conversations/${dmId}/messages`, {
      text: 'thread reply',
      replyTo: firstMessageId,
    });
    assertStatus('Thread reply send', replyResult, 200);
    const replyPayload = requireObject(replyResult.data, 'Thread reply');
    const replyMessage = requireObject(replyPayload.message, 'Thread reply message');
    const replyMessageId = requireString(replyMessage.id, 'reply message id');

    const reactAdd = await apiRequest(baseUrl, admin.token, 'POST', `/api/v1/chat/messages/${firstMessageId}/reactions`, {
      emoji: ':thumbsup:',
      op: 'add',
    });
    assertStatus('Reaction add', reactAdd, 200);

    const editReply = await apiRequest(baseUrl, member.token, 'PATCH', `/api/v1/chat/messages/${replyMessageId}`, {
      text: 'thread reply edited',
    });
    assertStatus('Message edit', editReply, 200);

    const deleteReply = await apiRequest(baseUrl, member.token, 'DELETE', `/api/v1/chat/messages/${replyMessageId}`);
    assertStatus('Message delete', deleteReply, 200);

    const listAfterDelete = await apiRequest(
      baseUrl,
      admin.token,
      'GET',
      `/api/v1/chat/conversations/${dmId}/messages?afterSeq=0&limit=50`
    );
    assertStatus('List messages after delete', listAfterDelete, 200);
    const listPayload = requireObject(listAfterDelete.data, 'List messages after delete');
    const listItems = Array.isArray(listPayload.items) ? (listPayload.items as Record<string, unknown>[]) : [];
    const deletedMessage = listItems.find((item) => item.id === replyMessageId) || null;
    const tombstoneSafe =
      deletedMessage !== null &&
      deletedMessage.body_text === null &&
      deletedMessage.body_rich === null &&
      Array.isArray(deletedMessage.attachments) &&
      deletedMessage.attachments.length === 0 &&
      Array.isArray(deletedMessage.reactions) &&
      deletedMessage.reactions.length === 0;
    recordStep('Tombstone no-leak check', tombstoneSafe);
    if (!tombstoneSafe) {
      throw new Error(`Deleted message payload is not tombstone-safe: ${JSON.stringify(deletedMessage)}`);
    }

    const forumCreate = await apiRequest(baseUrl, admin.token, 'POST', '/api/v1/chat/conversations', {
      type: 'FORUM_OPEN',
      title: 'Dry run forum',
    });
    assertStatus('Create forum', forumCreate, 200);
    const forumPayload = requireObject(forumCreate.data, 'Create forum');
    const forumConversation = requireObject(forumPayload.conversation, 'Create forum conversation');
    const forumId = requireString(forumConversation.id, 'forum conversation id');

    const memberForumSub = await subscribeSocket(memberSocket, forumId);
    const forumSubOk = memberForumSub.subscribed.includes(forumId);
    recordStep('WS subscribe forum before moderation', forumSubOk);
    if (!forumSubOk) throw new Error(`Forum subscribe failed before moderation: ${JSON.stringify(memberForumSub)}`);

    const muteResult = await apiRequest(baseUrl, admin.token, 'POST', `/api/v1/chat/conversations/${forumId}/moderation`, {
      userId: member.user.id,
      action: 'MUTE',
      until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      reason: 'dry-run mute',
    });
    assertStatus('Moderation MUTE', muteResult, 200);

    const mutedSend = await apiRequest(baseUrl, member.token, 'POST', `/api/v1/chat/conversations/${forumId}/messages`, {
      text: 'should be blocked while muted',
    });
    assertStatus('Muted send blocked', mutedSend, 403);
    const mutedPayload = requireObject(mutedSend.data, 'Muted send blocked');
    const mutedError = requireObject(mutedPayload.error, 'Muted send blocked error');
    const mutedCodeOk = mutedError.code === 'CHAT_MUTED';
    recordStep('Muted error code', mutedCodeOk);
    if (!mutedCodeOk) throw new Error(`Expected CHAT_MUTED, got ${JSON.stringify(mutedSend.data)}`);

    const unmuteResult = await apiRequest(
      baseUrl,
      admin.token,
      'POST',
      `/api/v1/chat/conversations/${forumId}/moderation`,
      {
        userId: member.user.id,
        action: 'UNMUTE',
      }
    );
    assertStatus('Moderation UNMUTE', unmuteResult, 200);

    const sendAfterUnmute = await apiRequest(
      baseUrl,
      member.token,
      'POST',
      `/api/v1/chat/conversations/${forumId}/messages`,
      {
        text: 'allowed after unmute',
      }
    );
    assertStatus('Send after unmute', sendAfterUnmute, 200);

    const banResult = await apiRequest(baseUrl, admin.token, 'POST', `/api/v1/chat/conversations/${forumId}/moderation`, {
      userId: member.user.id,
      action: 'BAN',
      until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      reason: 'dry-run ban',
    });
    assertStatus('Moderation BAN', banResult, 200);

    const bannedList = await apiRequest(
      baseUrl,
      member.token,
      'GET',
      `/api/v1/chat/conversations/${forumId}/messages?afterSeq=0&limit=20`
    );
    assertStatus('Banned list blocked', bannedList, 403);
    const bannedPayload = requireObject(bannedList.data, 'Banned list blocked');
    const bannedError = requireObject(bannedPayload.error, 'Banned list blocked error');
    const bannedCodeOk = bannedError.code === 'CHAT_BANNED';
    recordStep('Banned error code', bannedCodeOk);
    if (!bannedCodeOk) throw new Error(`Expected CHAT_BANNED, got ${JSON.stringify(bannedList.data)}`);

    const bannedSub = await subscribeSocket(memberSocket, forumId);
    const bannedSubBlocked = bannedSub.rejected.includes(forumId);
    recordStep('WS subscribe blocked while banned', bannedSubBlocked);
    if (!bannedSubBlocked) throw new Error(`Expected rejected subscription while banned: ${JSON.stringify(bannedSub)}`);

    const unbanResult = await apiRequest(
      baseUrl,
      admin.token,
      'POST',
      `/api/v1/chat/conversations/${forumId}/moderation`,
      {
        userId: member.user.id,
        action: 'UNBAN',
      }
    );
    assertStatus('Moderation UNBAN', unbanResult, 200);

    const archiveResult = await apiRequest(
      baseUrl,
      admin.token,
      'POST',
      `/api/v1/chat/conversations/${forumId}/archive`
    );
    assertStatus('Archive forum', archiveResult, 200);

    const archivedSend = await apiRequest(baseUrl, member.token, 'POST', `/api/v1/chat/conversations/${forumId}/messages`, {
      text: 'should be blocked while archived',
    });
    assertStatus('Archived send blocked', archivedSend, 409);
    const archivedPayload = requireObject(archivedSend.data, 'Archived send blocked');
    const archivedError = requireObject(archivedPayload.error, 'Archived send blocked error');
    const archivedCodeOk = archivedError.code === 'CHAT_ARCHIVED';
    recordStep('Archived error code', archivedCodeOk);
    if (!archivedCodeOk) throw new Error(`Expected CHAT_ARCHIVED, got ${JSON.stringify(archivedSend.data)}`);

    const unarchiveResult = await apiRequest(
      baseUrl,
      admin.token,
      'POST',
      `/api/v1/chat/conversations/${forumId}/unarchive`
    );
    assertStatus('Unarchive forum', unarchiveResult, 200);

    const hardDeleteDm = await apiRequest(baseUrl, superAdmin.token, 'DELETE', `/api/v1/chat/conversations/${dmId}`);
    assertStatus('Hard delete DM', hardDeleteDm, 200);

    const recreateDm = await apiRequest(baseUrl, admin.token, 'POST', '/api/v1/chat/dm', {
      otherUserId: member.user.id,
    });
    assertStatus('Recreate DM after hard delete', recreateDm, 200);
    const recreatePayload = requireObject(recreateDm.data, 'Recreate DM');
    const recreatedConversation = requireObject(recreatePayload.conversation, 'Recreate DM conversation');
    const recreatedDmId = requireString(recreatedConversation.id, 'recreated DM id');
    const recreatedIsNew = recreatedDmId !== dmId;
    recordStep('Recreated DM is new ACTIVE conversation', recreatedIsNew);
    if (!recreatedIsNew) throw new Error(`Expected recreated DM id to differ from deleted one (${dmId})`);
  } finally {
    if (adminSocket) adminSocket.close();
    if (memberSocket) memberSocket.close();
    if (fastify) {
      await fastify.close();
    }
    await closeDatabase();
  }
}

run()
  .then(() => {
    const failed = steps.filter((step) => !step.ok);
    const passed = steps.length - failed.length;
    console.log('\nChat dry-run summary');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed.length}`);
    if (failed.length) {
      for (const step of failed) {
        console.log(`- ${step.name}${step.details ? ` (${step.details})` : ''}`);
      }
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((error) => {
    recordStep('Chat dry-run fatal error', false, error instanceof Error ? error.message : String(error));
    console.error(error);
    process.exit(1);
  });
