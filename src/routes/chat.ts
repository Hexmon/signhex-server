import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { config as appConfig } from '@/config';
import { apiEndpoints } from '@/config/apiEndpoints';
import { chatAuthPreHandler, getRequestAuthContext } from '@/auth/request-auth';
import { createChatRepository } from '@/db/repositories/chat';
import { createAuditLogRepository } from '@/db/repositories/audit-log';
import { createLogger } from '@/utils/logger';
import { AppError } from '@/utils/app-error';
import { respondWithError } from '@/utils/errors';
import { emitChatEvent, setupChatNamespace } from '@/realtime/chat-namespace';
import { emitNotificationCountEvent } from '@/realtime/notifications-namespace';
import { notifyMessageEvent } from '@/chat/notify';
import { createNotificationCounterRepository } from '@/db/repositories/notification-counter';
import { createRateLimiter } from '@/chat/rate-limit';
import { assertAttachmentAccess, assertAttachmentMediaReady } from '@/chat/attachment-auth';
import { assertCanWriteToConversation, assertConversationWritable, assertNotBanned } from '@/chat/guard';
import { getDatabase, schema } from '@/db';
import { queueChatMediaCleanup, queueCleanup } from '@/jobs';

const logger = createLogger('chat-routes');
const chatRepo = createChatRepository();
const auditRepo = createAuditLogRepository();
const notificationCounterRepo = createNotificationCounterRepository();
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const createDmSchema = z.object({
  otherUserId: z.string().uuid(),
});

const createConversationSchema = z.object({
  type: z.enum(['GROUP_CLOSED', 'FORUM_OPEN']),
  title: z.string().min(1).max(255).optional(),
  topic: z.string().max(2000).optional(),
  purpose: z.string().max(2000).optional(),
  members: z.array(z.string().uuid()).optional(),
  invite_policy: z
    .enum(['ANY_MEMBER_CAN_INVITE', 'ADMINS_ONLY_CAN_INVITE', 'INVITES_DISABLED'])
    .optional(),
  settings: z
    .object({
      mention_policy: z
        .object({
          everyone: z.enum(['ANY_MEMBER', 'ADMINS_ONLY', 'DISABLED']).optional(),
          channel: z.enum(['ANY_MEMBER', 'ADMINS_ONLY', 'DISABLED']).optional(),
          here: z.enum(['ANY_MEMBER', 'ADMINS_ONLY', 'DISABLED']).optional(),
        })
        .optional(),
      edit_policy: z.enum(['OWN', 'ADMINS_ONLY', 'DISABLED']).optional(),
      delete_policy: z.enum(['OWN', 'ADMINS_ONLY', 'DISABLED']).optional(),
    })
    .optional(),
});

const listMessagesQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const sendMessageSchema = z
  .object({
    text: z.string().trim().min(1).optional(),
    replyTo: z.string().uuid().optional(),
    alsoToChannel: z.boolean().optional(),
    attachmentMediaIds: z.array(z.string().uuid()).optional(),
  })
  .refine((value) => Boolean(value.text || value.attachmentMediaIds?.length), {
    message: 'text or attachmentMediaIds is required',
  })
  .refine((value) => !value.alsoToChannel || Boolean(value.replyTo), {
    message: 'alsoToChannel is only valid for thread replies',
  });

const editMessageSchema = z.object({
  text: z.string().trim().min(1),
});

const reactionSchema = z.object({
  emoji: z.string().min(1).max(64),
  op: z.enum(['add', 'remove']),
});

const readSchema = z.object({
  lastReadSeq: z.coerce.number().int().min(0),
});

const inviteSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1),
});

const removeMemberSchema = z.object({
  userId: z.string().uuid(),
});

const updateConversationSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  topic: z.string().max(2000).optional(),
  purpose: z.string().max(2000).optional(),
  invite_policy: z
    .enum(['ANY_MEMBER_CAN_INVITE', 'ADMINS_ONLY_CAN_INVITE', 'INVITES_DISABLED'])
    .optional(),
  state: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  settings: z
    .object({
      mention_policy: z
        .object({
          everyone: z.enum(['ANY_MEMBER', 'ADMINS_ONLY', 'DISABLED']).optional(),
          channel: z.enum(['ANY_MEMBER', 'ADMINS_ONLY', 'DISABLED']).optional(),
          here: z.enum(['ANY_MEMBER', 'ADMINS_ONLY', 'DISABLED']).optional(),
        })
        .optional(),
      edit_policy: z.enum(['OWN', 'ADMINS_ONLY', 'DISABLED']).optional(),
      delete_policy: z.enum(['OWN', 'ADMINS_ONLY', 'DISABLED']).optional(),
    })
    .optional(),
});

const moderationSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(['MUTE', 'BAN', 'UNMUTE', 'UNBAN']),
  until: z.string().datetime().optional(),
  reason: z.string().max(2000).optional(),
});

const bookmarkSchema = z.object({
  type: z.enum(['LINK', 'FILE', 'MESSAGE']),
  label: z.string().min(1).max(255),
  emoji: z.string().max(32).optional(),
  url: z.string().url().optional(),
  mediaAssetId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

function isAdminRole(roleName: string | undefined): boolean {
  return roleName === 'ADMIN' || roleName === 'SUPER_ADMIN';
}

function parseMentionedUserIds(text?: string): string[] {
  if (!text) return [];
  const regex = /@([0-9a-fA-F-]{36})/g;
  const ids = new Set<string>();
  for (const match of text.matchAll(regex)) {
    if (match[1]) ids.add(match[1]);
  }
  return Array.from(ids);
}

type MentionPolicyValue = 'ANY_MEMBER' | 'ADMINS_ONLY' | 'DISABLED';
type MutationPolicyValue = 'OWN' | 'ADMINS_ONLY' | 'DISABLED';
type ConversationSettings = {
  mention_policy: {
    everyone: MentionPolicyValue;
    channel: MentionPolicyValue;
    here: MentionPolicyValue;
  };
  edit_policy: MutationPolicyValue;
  delete_policy: MutationPolicyValue;
};

const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  mention_policy: {
    everyone: 'ADMINS_ONLY',
    channel: 'ADMINS_ONLY',
    here: 'ANY_MEMBER',
  },
  edit_policy: 'OWN',
  delete_policy: 'OWN',
};

function parseSpecialMentions(text?: string): Array<'everyone' | 'channel' | 'here'> {
  if (!text) return [];
  const found = new Set<'everyone' | 'channel' | 'here'>();
  const regex = /@(?:everyone|channel|here)\b/gi;
  for (const match of text.matchAll(regex)) {
    const token = match[0].slice(1).toLowerCase();
    if (token === 'everyone' || token === 'channel' || token === 'here') {
      found.add(token);
    }
  }
  return Array.from(found);
}

function getConversationSettings(conversation: {
  metadata?: unknown;
}): ConversationSettings {
  const metadata =
    conversation.metadata && typeof conversation.metadata === 'object'
      ? (conversation.metadata as Record<string, unknown>)
      : {};
  const settings =
    metadata.settings && typeof metadata.settings === 'object'
      ? (metadata.settings as Record<string, unknown>)
      : {};
  const mentionPolicy =
    settings.mention_policy && typeof settings.mention_policy === 'object'
      ? (settings.mention_policy as Record<string, unknown>)
      : {};

  const normalizeMention = (key: 'everyone' | 'channel' | 'here'): MentionPolicyValue => {
    const value = mentionPolicy[key];
    return value === 'ANY_MEMBER' || value === 'ADMINS_ONLY' || value === 'DISABLED'
      ? value
      : DEFAULT_CONVERSATION_SETTINGS.mention_policy[key];
  };

  const normalizeMutation = (value: unknown, fallback: MutationPolicyValue): MutationPolicyValue =>
    value === 'OWN' || value === 'ADMINS_ONLY' || value === 'DISABLED' ? value : fallback;

  return {
    mention_policy: {
      everyone: normalizeMention('everyone'),
      channel: normalizeMention('channel'),
      here: normalizeMention('here'),
    },
    edit_policy: normalizeMutation(
      settings.edit_policy,
      DEFAULT_CONVERSATION_SETTINGS.edit_policy
    ),
    delete_policy: normalizeMutation(
      settings.delete_policy,
      DEFAULT_CONVERSATION_SETTINGS.delete_policy
    ),
  };
}

function mergeConversationMetadataSettings(
  currentMetadata: unknown,
  settingsPatch: z.infer<typeof updateConversationSchema>['settings'] | z.infer<typeof createConversationSchema>['settings'] | undefined
) {
  const baseMetadata =
    currentMetadata && typeof currentMetadata === 'object'
      ? ({ ...(currentMetadata as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  if (!settingsPatch) return baseMetadata;

  const currentSettings = getConversationSettings({ metadata: currentMetadata });
  const nextSettings: ConversationSettings = {
    mention_policy: {
      everyone:
        settingsPatch.mention_policy?.everyone ??
        currentSettings.mention_policy.everyone,
      channel:
        settingsPatch.mention_policy?.channel ??
        currentSettings.mention_policy.channel,
      here:
        settingsPatch.mention_policy?.here ??
        currentSettings.mention_policy.here,
    },
    edit_policy: settingsPatch.edit_policy ?? currentSettings.edit_policy,
    delete_policy: settingsPatch.delete_policy ?? currentSettings.delete_policy,
  };
  baseMetadata.settings = nextSettings;
  return baseMetadata;
}

function canMutateMessageByPolicy(input: {
  policy: MutationPolicyValue;
  isOwner: boolean;
  isConversationAdmin: boolean;
}): boolean {
  if (input.policy === 'DISABLED') return false;
  if (input.policy === 'ADMINS_ONLY') return input.isConversationAdmin;
  return input.isOwner;
}

async function appendAudit(
  request: FastifyRequest,
  userId: string,
  action: string,
  entityType: string,
  entityId?: string
) {
  try {
    await auditRepo.create({
      user_id: userId,
      action,
      resource_type: entityType,
      resource_id: entityId,
      ip_address: request.ip,
      user_agent: request.headers['user-agent'] as string | undefined,
    });
  } catch (error) {
    logger.warn(error, 'Failed to persist chat audit event');
  }
}

function authenticate(request: FastifyRequest) {
  return getRequestAuthContext(request);
}

async function getConversationForAccess(
  conversationId: string,
  userId: string,
  roleName?: string
) {
  const conversation = await chatRepo.getConversationById(conversationId);
  if (!conversation || conversation.state === 'DELETED') throw AppError.notFound('Conversation not found');
  const canAccess = await chatRepo.canAccessConversation(conversationId, userId, roleName);
  if (!canAccess) throw AppError.forbidden('Forbidden');
  return conversation;
}

function buildConversationShareLink(conversationId: string): { path: string; url?: string } {
  const path = `/chat/${conversationId}`;
  if (!appConfig.APP_PUBLIC_BASE_URL) {
    return { path };
  }

  const baseUrl = appConfig.APP_PUBLIC_BASE_URL.replace(/\/+$/, '');
  return {
    path,
    url: `${baseUrl}${path}`,
  };
}

export async function chatRoutes(fastify: FastifyInstance) {
  await setupChatNamespace(fastify);
  const forumLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 1 });
  const forumAttachmentLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 0.5 });
  const db = getDatabase();

  fastify.post<{ Body: typeof createDmSchema._type }>(
    apiEndpoints.chat.createDm,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = createDmSchema.parse(request.body);
        if (data.otherUserId === payload.sub) throw AppError.badRequest('Cannot create DM with yourself');

        const conversation = await chatRepo.getOrCreateDm(payload.sub, data.otherUserId);
        await appendAudit(request, payload.sub, 'CHAT_CONVERSATION_CREATE', 'ChatConversation', conversation.id);
        return reply.send({ conversation });
      } catch (error) {
        logger.error(error, 'Create DM error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Body: typeof createConversationSchema._type }>(
    apiEndpoints.chat.createConversation,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = createConversationSchema.parse(request.body);
        const metadata = mergeConversationMetadataSettings({}, data.settings);
        const conversation = await chatRepo.createConversation({
          type: data.type,
          title: data.title,
          topic: data.topic,
          purpose: data.purpose,
          invite_policy: data.invite_policy,
          createdBy: payload.sub,
          members: data.members,
          metadata,
        });
        await appendAudit(request, payload.sub, 'CHAT_CONVERSATION_CREATE', 'ChatConversation', conversation.id);
        emitChatEvent(fastify, conversation.id, 'chat:conversation:updated', {
          conversationId: conversation.id,
          patch: { state: conversation.state },
        });
        return reply.send({ conversation });
      } catch (error) {
        logger.error(error, 'Create conversation error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.chat.listConversations,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const items = await chatRepo.listConversations(payload.sub);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List conversations error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.chat.getConversation,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertNotBanned(moderation);
        const member = await chatRepo.getMember(conversationId, payload.sub);

        return reply.send({
          conversation: {
            id: conversation.id,
            type: conversation.type,
            state: conversation.state,
            title: conversation.title,
            topic: conversation.topic,
            purpose: conversation.purpose,
            invite_policy: conversation.invite_policy,
            last_seq: conversation.last_seq,
          },
          viewer: {
            is_member: Boolean(member),
            role: member?.role ?? null,
          },
        });
      } catch (error) {
        logger.error(error, 'Get conversation error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.chat.shareLink,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const conversationId = (request.params as any).id;
        await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertNotBanned(moderation);
        return reply.send(buildConversationShareLink(conversationId));
      } catch (error) {
        logger.error(error, 'Share link error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: typeof listMessagesQuerySchema._type }>(
    apiEndpoints.chat.listMessages,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const query = listMessagesQuerySchema.parse(request.query);
        const conversationId = (request.params as any).id;
        await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertNotBanned(moderation);
        const items = await chatRepo.listMessages(conversationId, {
          afterSeq: query.afterSeq,
          limit: query.limit,
        });
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List messages error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string; parentMessageId: string }; Querystring: typeof listMessagesQuerySchema._type }>(
    apiEndpoints.chat.listThread,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const query = listMessagesQuerySchema.parse(request.query);
        const conversationId = (request.params as any).id;
        const parentMessageId = (request.params as any).parentMessageId;
        await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertNotBanned(moderation);
        const parentMessage = await chatRepo.getMessageById(parentMessageId);
        if (!parentMessage || parentMessage.conversation_id !== conversationId) {
          throw AppError.notFound('Parent message not found');
        }
        const threadRootId = parentMessage.thread_root_id || parentMessage.id;
        const items = await chatRepo.listMessages(conversationId, {
          afterSeq: query.afterSeq,
          limit: query.limit,
          threadRootId,
        });
        return reply.send({ items, threadRootId });
      } catch (error) {
        logger.error(error, 'List thread error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof sendMessageSchema._type }>(
    apiEndpoints.chat.sendMessage,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload, ability } = await authenticate(request);
        const data = sendMessageSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        if (data.attachmentMediaIds?.length && data.attachmentMediaIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
          throw new AppError({
            statusCode: 400,
            code: 'CHAT_TOO_MANY_ATTACHMENTS',
            message: `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments allowed per message`,
          });
        }

        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertCanWriteToConversation(conversation, moderation);
        const settings = getConversationSettings(conversation);
        const specialMentions = parseSpecialMentions(data.text);
        if (specialMentions.length && conversation.type !== 'DM') {
          const canAdmin = await chatRepo.isConversationAdmin(conversationId, payload.sub, payload.role);
          for (const mention of specialMentions) {
            const policy = settings.mention_policy[mention];
            if (policy === 'DISABLED') {
              throw new AppError({
                statusCode: 403,
                code: 'CHAT_MENTION_POLICY_VIOLATION',
                message: `@${mention} mentions are disabled in this conversation`,
              });
            }
            if (policy === 'ADMINS_ONLY' && !canAdmin) {
              throw new AppError({
                statusCode: 403,
                code: 'CHAT_MENTION_POLICY_VIOLATION',
                message: `@${mention} mention is restricted to admins`,
              });
            }
          }
        }

        if (conversation.type === 'FORUM_OPEN') {
          const key = `${payload.sub}:${conversationId}:forum`;
          const messageLimit = forumLimiter.consume(key);
          if (!messageLimit.allowed) {
            throw AppError.rateLimited(
              `Forum message rate limit exceeded. Retry in ${messageLimit.retryAfterSeconds ?? 1}s`
            );
          }
          if (data.attachmentMediaIds?.length) {
            const attachmentLimit = forumAttachmentLimiter.consume(`${key}:attachments`, data.attachmentMediaIds.length);
            if (!attachmentLimit.allowed) {
              throw AppError.rateLimited(
                `Attachment rate limit exceeded. Retry in ${attachmentLimit.retryAfterSeconds ?? 1}s`
              );
            }
          }
        }

        if (data.attachmentMediaIds?.length) {
          const attachmentMediaIds = Array.from(new Set(data.attachmentMediaIds));
          const mediaRows = await db
            .select()
            .from(schema.media)
            .where(inArray(schema.media.id, attachmentMediaIds));

          assertAttachmentMediaReady(mediaRows);

          assertAttachmentAccess({
            requestedMediaIds: attachmentMediaIds,
            mediaRows: mediaRows as Array<{ id: string; created_by?: string | null }>,
            senderId: payload.sub,
            senderRole: payload.role,
            senderDepartmentId: payload.department_id,
            canOverrideMedia: ability.can('update', 'Media'),
          });

          data.attachmentMediaIds = attachmentMediaIds;
        }

        const bodyRich = {
          mentions: parseMentionedUserIds(data.text),
        };

        const { message, threadRootSenderId } = await chatRepo.sendMessageTx({
          conversationId,
          senderId: payload.sub,
          bodyText: data.text,
          bodyRich,
          replyToMessageId: data.replyTo,
          alsoToChannel: data.alsoToChannel,
          attachmentMediaIds: data.attachmentMediaIds,
        });

        const members = conversation.type === 'DM' ? await chatRepo.listMembers(conversationId) : [];
        const participantA = members[0]?.user_id ?? null;
        const participantB = members[1]?.user_id ?? null;
        notifyMessageEvent({
          conversation: {
            id: conversationId,
            type: conversation.type as any,
            title: conversation.title,
            participantA,
            participantB,
          },
          message: {
            id: message.id,
            body_text: message.body_text,
          },
          senderId: payload.sub,
          mentionedUserIds: bodyRich.mentions,
          threadRootSenderId,
          onNotificationCreated: async ({ userId }) => {
            const unread_total = await notificationCounterRepo.getUnreadTotal(userId);
            emitNotificationCountEvent(fastify, userId, unread_total);
          },
        }).catch((error) => {
          logger.warn(error, 'Notification dispatch failed');
        });

        await appendAudit(request, payload.sub, 'CHAT_MESSAGE_SEND', 'ChatMessage', message.id);
        emitChatEvent(fastify, conversationId, 'chat:message:new', {
          conversationId,
          seq: message.seq,
          message,
        });

        return reply.send({ message });
      } catch (error) {
        logger.error(error, 'Send message error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.patch<{ Params: { id: string }; Body: typeof editMessageSchema._type }>(
    apiEndpoints.chat.editMessage,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = editMessageSchema.parse(request.body);
        const row = await chatRepo.getConversationForMessage((request.params as any).id);
        if (!row) throw AppError.notFound('Message not found');
        const conversation = await getConversationForAccess(row.conversation.id, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(row.conversation.id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);
        const settings = getConversationSettings(conversation);
        const isOwner = row.message.sender_id === payload.sub;
        const isConversationAdmin = await chatRepo.isConversationAdmin(
          row.conversation.id,
          payload.sub,
          payload.role
        );
        const specialMentions = parseSpecialMentions(data.text);
        if (specialMentions.length && conversation.type !== 'DM') {
          for (const mention of specialMentions) {
            const policy = settings.mention_policy[mention];
            if (policy === 'DISABLED') {
              throw new AppError({
                statusCode: 403,
                code: 'CHAT_MENTION_POLICY_VIOLATION',
                message: `@${mention} mentions are disabled in this conversation`,
              });
            }
            if (policy === 'ADMINS_ONLY' && !isConversationAdmin) {
              throw new AppError({
                statusCode: 403,
                code: 'CHAT_MENTION_POLICY_VIOLATION',
                message: `@${mention} mention is restricted to admins`,
              });
            }
          }
        }
        const canEdit = canMutateMessageByPolicy({
          policy: settings.edit_policy,
          isOwner,
          isConversationAdmin,
        });
        if (!canEdit) {
          if (settings.edit_policy === 'DISABLED') {
            throw new AppError({
              statusCode: 403,
              code: 'CHAT_EDIT_POLICY_DISABLED',
              message: 'Message editing is disabled in this conversation',
            });
          }
          throw new AppError({
            statusCode: 403,
            code: 'CHAT_EDIT_POLICY_FORBIDDEN',
            message: 'You cannot edit this message',
          });
        }

        const message = await chatRepo.editMessage({
          messageId: row.message.id,
          editorId: payload.sub,
          newBodyText: data.text,
          newBodyRich: { mentions: parseMentionedUserIds(data.text) },
        });

        await appendAudit(request, payload.sub, 'CHAT_MESSAGE_EDIT', 'ChatMessage', row.message.id);
        emitChatEvent(fastify, row.conversation.id, 'chat:message:updated', {
          conversationId: row.conversation.id,
          messageId: row.message.id,
          patch: message,
        });
        return reply.send({ message });
      } catch (error) {
        logger.error(error, 'Edit message error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.chat.deleteMessage,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const row = await chatRepo.getConversationForMessage((request.params as any).id);
        if (!row) throw AppError.notFound('Message not found');
        const conversation = await getConversationForAccess(row.conversation.id, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(row.conversation.id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);
        const settings = getConversationSettings(conversation);
        const isOwner = row.message.sender_id === payload.sub;
        const isConversationAdmin = await chatRepo.isConversationAdmin(
          row.conversation.id,
          payload.sub,
          payload.role
        );
        const canDelete = canMutateMessageByPolicy({
          policy: settings.delete_policy,
          isOwner,
          isConversationAdmin,
        });
        if (!canDelete) {
          if (settings.delete_policy === 'DISABLED') {
            throw new AppError({
              statusCode: 403,
              code: 'CHAT_DELETE_POLICY_DISABLED',
              message: 'Message deletion is disabled in this conversation',
            });
          }
          throw new AppError({
            statusCode: 403,
            code: 'CHAT_DELETE_POLICY_FORBIDDEN',
            message: 'You cannot delete this message',
          });
        }

        const result = await chatRepo.softDeleteMessage({
          messageId: row.message.id,
          editorId: payload.sub,
        });
        const message = result.message;

        if (result.detachedMediaAssetIds.length) {
          try {
            await queueChatMediaCleanup({
              conversationId: row.conversation.id,
              mediaAssetIds: result.detachedMediaAssetIds,
              source: 'message-delete',
              messageId: row.message.id,
            });
          } catch (queueError) {
            logger.warn(queueError, 'Failed to enqueue chat media cleanup for deleted message');
            try {
              await queueCleanup({
                type: 'chat_orphaned_media',
                mediaAssetIds: result.detachedMediaAssetIds,
                conversationId: row.conversation.id,
                messageId: row.message.id,
              });
            } catch (fallbackError) {
              logger.warn(fallbackError, 'Failed to enqueue fallback chat media cleanup');
            }
          }
        }

        await appendAudit(request, payload.sub, 'CHAT_MESSAGE_DELETE', 'ChatMessage', row.message.id);
        emitChatEvent(fastify, row.conversation.id, 'chat:message:deleted', {
          conversationId: row.conversation.id,
          messageId: row.message.id,
          seq: message.seq,
        });
        return reply.send({ message });
      } catch (error) {
        logger.error(error, 'Delete message error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof reactionSchema._type }>(
    apiEndpoints.chat.reactToMessage,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = reactionSchema.parse(request.body);
        const row = await chatRepo.getConversationForMessage((request.params as any).id);
        if (!row) throw AppError.notFound('Message not found');
        const conversation = await getConversationForAccess(row.conversation.id, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(row.conversation.id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);

        const result = await chatRepo.updateReaction({
          messageId: row.message.id,
          userId: payload.sub,
          emoji: data.emoji,
          op: data.op,
        });

        await appendAudit(
          request,
          payload.sub,
          data.op === 'add' ? 'CHAT_REACTION_ADD' : 'CHAT_REACTION_REMOVE',
          'ChatMessage',
          row.message.id
        );
        emitChatEvent(fastify, row.conversation.id, 'chat:message:updated', {
          conversationId: row.conversation.id,
          messageId: row.message.id,
          patch: { reactions: result.reactions },
        });

        return reply.send(result);
      } catch (error) {
        logger.error(error, 'Reaction update error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.chat.pinMessage,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const row = await chatRepo.getConversationForMessage((request.params as any).id);
        if (!row) throw AppError.notFound('Message not found');
        const conversation = await getConversationForAccess(row.conversation.id, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(row.conversation.id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);

        const pin = await chatRepo.pinMessage({
          conversationId: row.conversation.id,
          messageId: row.message.id,
          pinnedBy: payload.sub,
        });
        await appendAudit(request, payload.sub, 'CHAT_PIN_ADD', 'ChatMessage', row.message.id);
        emitChatEvent(fastify, row.conversation.id, 'chat:pin:update', {
          conversationId: row.conversation.id,
          messageId: row.message.id,
          pinned: true,
          pin,
        });
        return reply.send({ pin });
      } catch (error) {
        logger.error(error, 'Pin message error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.chat.unpinMessage,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const row = await chatRepo.getConversationForMessage((request.params as any).id);
        if (!row) throw AppError.notFound('Message not found');
        const conversation = await getConversationForAccess(row.conversation.id, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(row.conversation.id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);

        const removed = await chatRepo.unpinMessage(row.conversation.id, row.message.id);
        await appendAudit(request, payload.sub, 'CHAT_PIN_REMOVE', 'ChatMessage', row.message.id);
        emitChatEvent(fastify, row.conversation.id, 'chat:pin:update', {
          conversationId: row.conversation.id,
          messageId: row.message.id,
          pinned: false,
        });
        return reply.send({ success: removed });
      } catch (error) {
        logger.error(error, 'Unpin message error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.chat.listPins,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const conversationId = (request.params as any).id;
        await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertNotBanned(moderation);
        const items = await chatRepo.listPins(conversationId);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List pins error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof bookmarkSchema._type }>(
    apiEndpoints.chat.createBookmark,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = bookmarkSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertCanWriteToConversation(conversation, moderation);

        const { bookmark, created } = await chatRepo.createBookmark({
          conversationId,
          type: data.type,
          label: data.label,
          emoji: data.emoji,
          url: data.url,
          mediaAssetId: data.mediaAssetId,
          messageId: data.messageId,
          metadata: data.metadata,
          createdBy: payload.sub,
        });
        if (created) {
          await appendAudit(request, payload.sub, 'CHAT_BOOKMARK_ADD', 'ChatConversation', conversationId);
          emitChatEvent(fastify, conversationId, 'chat:bookmark:update', {
            conversationId,
            bookmarkId: bookmark.id,
            op: 'add',
          });
        }
        return reply.send({ bookmark });
      } catch (error) {
        logger.error(error, 'Create bookmark error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.chat.listBookmarks,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const conversationId = (request.params as any).id;
        await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertNotBanned(moderation);
        const items = await chatRepo.listBookmarks(conversationId);
        return reply.send({ items });
      } catch (error) {
        logger.error(error, 'List bookmarks error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.chat.deleteBookmark,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const bookmarkId = (request.params as any).id;
        const bookmark = await chatRepo.getBookmarkById(bookmarkId);
        if (!bookmark) throw AppError.notFound('Bookmark not found');
        const conversation = await getConversationForAccess(
          bookmark.conversation_id,
          payload.sub,
          payload.role
        );
        const moderation = await chatRepo.getModeration(bookmark.conversation_id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);

        const isConversationAdmin = await chatRepo.isConversationAdmin(
          bookmark.conversation_id,
          payload.sub,
          payload.role
        );
        if (bookmark.created_by !== payload.sub && !isConversationAdmin) {
          throw AppError.forbidden('Only creator or chat admin can remove bookmark');
        }

        const deleted = await chatRepo.deleteBookmark(bookmarkId);
        await appendAudit(request, payload.sub, 'CHAT_BOOKMARK_REMOVE', 'ChatConversation', bookmark.conversation_id);
        emitChatEvent(fastify, bookmark.conversation_id, 'chat:bookmark:update', {
          conversationId: bookmark.conversation_id,
          bookmarkId,
          op: 'remove',
        });
        return reply.send({ success: Boolean(deleted) });
      } catch (error) {
        logger.error(error, 'Delete bookmark error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof readSchema._type }>(
    apiEndpoints.chat.markRead,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = readSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertNotBanned(moderation);

        const receipt = await chatRepo.markRead(conversationId, payload.sub, data.lastReadSeq);
        return reply.send({ receipt });
      } catch (error) {
        logger.error(error, 'Mark read error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof inviteSchema._type }>(
    apiEndpoints.chat.inviteMembers,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = inviteSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        assertConversationWritable(conversation);
        if (conversation.type === 'DM') throw AppError.forbidden('DM does not support invites');

        const member = await chatRepo.getMember(conversationId, payload.sub);
        const isConvAdmin = await chatRepo.isConversationAdmin(conversationId, payload.sub, payload.role);
        if (conversation.invite_policy === 'INVITES_DISABLED' && !isAdminRole(payload.role)) {
          throw AppError.forbidden('Invites are disabled');
        }
        if (conversation.invite_policy === 'ADMINS_ONLY_CAN_INVITE' && !isConvAdmin) {
          throw AppError.forbidden('Only admins can invite members');
        }
        if (conversation.invite_policy === 'ANY_MEMBER_CAN_INVITE' && !member && !isConvAdmin) {
          throw AppError.forbidden('Only members can invite');
        }

        await chatRepo.inviteMembers(conversationId, Array.from(new Set(data.userIds)));
        await chatRepo.ensureSystemAdmins(conversationId);
        await appendAudit(request, payload.sub, 'CHAT_MEMBER_INVITE', 'ChatConversation', conversationId);
        emitChatEvent(fastify, conversationId, 'chat:conversation:updated', {
          conversationId,
          patch: { membersChanged: true },
        });
        return reply.send({ success: true });
      } catch (error) {
        logger.error(error, 'Invite members error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof removeMemberSchema._type }>(
    apiEndpoints.chat.removeMember,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = removeMemberSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        assertConversationWritable(conversation);
        if (conversation.type === 'DM') throw AppError.forbidden('Cannot remove DM participants');
        const canAdmin = await chatRepo.isConversationAdmin(conversationId, payload.sub, payload.role);
        if (!canAdmin) throw AppError.forbidden('Only chat admins can remove members');
        await chatRepo.removeMember(conversationId, data.userId);
        await appendAudit(request, payload.sub, 'CHAT_MEMBER_REMOVE', 'ChatConversation', conversationId);
        emitChatEvent(fastify, conversationId, 'chat:conversation:updated', {
          conversationId,
          patch: { membersChanged: true },
        });
        return reply.send({ success: true });
      } catch (error) {
        logger.error(error, 'Remove member error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.patch<{ Params: { id: string }; Body: typeof updateConversationSchema._type }>(
    apiEndpoints.chat.updateConversation,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = updateConversationSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        assertConversationWritable(conversation);
        if (conversation.type === 'DM') throw AppError.forbidden('DM metadata cannot be updated');
        const canAdmin = await chatRepo.isConversationAdmin(conversationId, payload.sub, payload.role);
        if (!canAdmin) throw AppError.forbidden('Only chat admins can update conversation');

        const metadata = data.settings
          ? mergeConversationMetadataSettings(conversation.metadata, data.settings)
          : conversation.metadata && typeof conversation.metadata === 'object'
          ? (conversation.metadata as Record<string, unknown>)
          : {};
        const patch = {
          title: data.title,
          topic: data.topic,
          purpose: data.purpose,
          invite_policy: data.invite_policy,
          state: data.state,
          metadata,
        };

        const updated = await chatRepo.updateConversation(conversationId, patch);
        if (!updated) throw AppError.notFound('Conversation not found');
        await appendAudit(request, payload.sub, 'CHAT_CONVERSATION_UPDATE', 'ChatConversation', conversationId);
        emitChatEvent(fastify, conversationId, 'chat:conversation:updated', {
          conversationId,
          patch: data,
        });
        return reply.send({ conversation: updated });
      } catch (error) {
        logger.error(error, 'Update conversation error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.chat.archiveConversation,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        if (conversation.type === 'DM') throw AppError.forbidden('DM cannot be archived');
        if (!isAdminRole(payload.role)) throw AppError.forbidden('Only admin can archive');
        const updated = await chatRepo.archiveConversation(conversationId);
        await appendAudit(request, payload.sub, 'CHAT_CONVERSATION_ARCHIVE', 'ChatConversation', conversationId);
        emitChatEvent(fastify, conversationId, 'chat:conversation:updated', {
          conversationId,
          patch: { state: 'ARCHIVED' },
        });
        return reply.send({ conversation: updated });
      } catch (error) {
        logger.error(error, 'Archive conversation error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    apiEndpoints.chat.unarchiveConversation,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        if (conversation.type === 'DM') throw AppError.forbidden('DM cannot be unarchived');
        if (!isAdminRole(payload.role)) throw AppError.forbidden('Only admin can unarchive');
        const updated = await chatRepo.unarchiveConversation(conversationId);
        await appendAudit(request, payload.sub, 'CHAT_CONVERSATION_UNARCHIVE', 'ChatConversation', conversationId);
        emitChatEvent(fastify, conversationId, 'chat:conversation:updated', {
          conversationId,
          patch: { state: 'ACTIVE' },
        });
        return reply.send({ conversation: updated });
      } catch (error) {
        logger.error(error, 'Unarchive conversation error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    apiEndpoints.chat.hardDeleteConversation,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        if (payload.role !== 'SUPER_ADMIN') {
          throw AppError.forbidden('Only super admin can hard delete conversations');
        }
        const conversationId = (request.params as any).id;
        const conversation = await chatRepo.getConversationById(conversationId);
        if (!conversation || conversation.state === 'DELETED') {
          throw AppError.notFound('Conversation not found');
        }

        const result = await chatRepo.hardDeleteConversation(conversationId);
        if (result.mediaAssetIds.length) {
          try {
            await queueChatMediaCleanup({
              conversationId,
              mediaAssetIds: result.mediaAssetIds,
              source: 'conversation-delete',
            });
          } catch (queueError) {
            logger.warn(queueError, 'Failed to enqueue chat media cleanup for hard-deleted conversation');
            try {
              await queueCleanup({
                type: 'chat_orphaned_media',
                mediaAssetIds: result.mediaAssetIds,
                conversationId,
              });
            } catch (fallbackError) {
              logger.warn(fallbackError, 'Failed to enqueue fallback chat media cleanup');
            }
          }
        }

        await appendAudit(request, payload.sub, 'CHAT_CONVERSATION_DELETE', 'ChatConversation', conversationId);
        emitChatEvent(fastify, conversationId, 'chat:conversation:updated', {
          conversationId,
          patch: { state: 'DELETED' },
        });
        return reply.send({ success: true, conversationId });
      } catch (error) {
        logger.error(error, 'Hard delete conversation error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string }; Body: typeof moderationSchema._type }>(
    apiEndpoints.chat.moderateConversation,
    { preHandler: chatAuthPreHandler, schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = moderationSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        assertConversationWritable(conversation);

        if (conversation.type === 'DM') throw AppError.forbidden('Moderation is not supported for DM');
        if (!isAdminRole(payload.role)) {
          throw AppError.forbidden('Only admin can moderate conversations');
        }

        const moderation = await chatRepo.applyModerationAction({
          conversationId,
          userId: data.userId,
          action: data.action,
          until: data.until ? new Date(data.until) : undefined,
          reason: data.reason,
        });

        const auditAction =
          data.action === 'MUTE'
            ? 'CHAT_MODERATION_MUTE'
            : data.action === 'BAN'
            ? 'CHAT_MODERATION_BAN'
            : data.action === 'UNMUTE'
            ? 'CHAT_MODERATION_UNMUTE'
            : 'CHAT_MODERATION_UNBAN';

        await appendAudit(request, payload.sub, auditAction, 'ChatConversation', conversationId);
        emitChatEvent(fastify, conversationId, 'chat:conversation:updated', {
          conversationId,
          patch: {
            moderationChanged: true,
            action: data.action,
            userId: data.userId,
          },
        });

        return reply.send({ moderation });
      } catch (error) {
        logger.error(error, 'Moderation update error');
        return respondWithError(reply, error);
      }
    }
  );
}
