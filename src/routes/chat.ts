import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { apiEndpoints } from '@/config/apiEndpoints';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createChatRepository } from '@/db/repositories/chat';
import { createAuditLogRepository } from '@/db/repositories/audit-log';
import { createLogger } from '@/utils/logger';
import { AppError } from '@/utils/app-error';
import { respondWithError } from '@/utils/errors';
import { emitChatEvent, setupChatNamespace } from '@/realtime/chat-namespace';
import { notifyMessageEvent } from '@/chat/notify';
import { createRateLimiter } from '@/chat/rate-limit';
import { assertAttachmentAccess } from '@/chat/attachment-auth';
import { assertCanWriteToConversation, assertConversationWritable, assertNotBanned } from '@/chat/guard';
import { getDatabase, schema } from '@/db';
import { queueChatMediaCleanup } from '@/jobs';

const logger = createLogger('chat-routes');
const chatRepo = createChatRepository();
const auditRepo = createAuditLogRepository();

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
});

const listMessagesQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const sendMessageSchema = z
  .object({
    text: z.string().trim().min(1).optional(),
    replyTo: z.string().uuid().optional(),
    attachmentMediaIds: z.array(z.string().uuid()).optional(),
  })
  .refine((value) => Boolean(value.text || value.attachmentMediaIds?.length), {
    message: 'text or attachmentMediaIds is required',
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
});

const moderationSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(['MUTE', 'BAN', 'UNMUTE', 'UNBAN']),
  until: z.string().datetime().optional(),
  reason: z.string().max(2000).optional(),
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

async function authenticate(request: FastifyRequest) {
  const token = extractTokenFromHeader(request.headers.authorization);
  if (!token) throw AppError.unauthorized('Missing authorization header');
  const payload = await verifyAccessToken(token);
  const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
  return { payload, ability };
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

export async function chatRoutes(fastify: FastifyInstance) {
  await setupChatNamespace(fastify);
  const forumLimiter = createRateLimiter({ capacity: 30, refillPerSecond: 1 });
  const forumAttachmentLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 0.5 });
  const db = getDatabase();

  fastify.post<{ Body: typeof createDmSchema._type }>(
    apiEndpoints.chat.createDm,
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = createConversationSchema.parse(request.body);
        const conversation = await chatRepo.createConversation({
          type: data.type,
          title: data.title,
          topic: data.topic,
          purpose: data.purpose,
          invite_policy: data.invite_policy,
          createdBy: payload.sub,
          members: data.members,
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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

  fastify.get<{ Params: { id: string }; Querystring: typeof listMessagesQuerySchema._type }>(
    apiEndpoints.chat.listMessages,
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload, ability } = await authenticate(request);
        const data = sendMessageSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(conversationId, payload.sub);
        assertCanWriteToConversation(conversation, moderation);

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
          const mediaRows = await db
            .select()
            .from(schema.media)
            .where(inArray(schema.media.id, data.attachmentMediaIds));
          assertAttachmentAccess({
            requestedMediaIds: data.attachmentMediaIds,
            mediaRows: mediaRows as Array<{ id: string; created_by?: string | null }>,
            senderId: payload.sub,
            senderRole: payload.role,
            senderDepartmentId: payload.department_id,
            canOverrideMedia: ability.can('update', 'Media'),
          });
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = editMessageSchema.parse(request.body);
        const row = await chatRepo.getConversationForMessage((request.params as any).id);
        if (!row) throw AppError.notFound('Message not found');
        const conversation = await getConversationForAccess(row.conversation.id, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(row.conversation.id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);
        const isOwner = row.message.sender_id === payload.sub;
        if (!isOwner && !isAdminRole(payload.role)) {
          throw AppError.forbidden('You cannot edit this message');
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const row = await chatRepo.getConversationForMessage((request.params as any).id);
        if (!row) throw AppError.notFound('Message not found');
        const conversation = await getConversationForAccess(row.conversation.id, payload.sub, payload.role);
        const moderation = await chatRepo.getModeration(row.conversation.id, payload.sub);
        assertCanWriteToConversation(conversation, moderation);
        const isOwner = row.message.sender_id === payload.sub;
        if (!isOwner && !isAdminRole(payload.role)) {
          throw AppError.forbidden('You cannot delete this message');
        }

        const message = await chatRepo.softDeleteMessage({
          messageId: row.message.id,
          editorId: payload.sub,
        });

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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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

  fastify.post<{ Params: { id: string }; Body: typeof readSchema._type }>(
    apiEndpoints.chat.markRead,
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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

        const updated = await chatRepo.updateConversation(conversationId, data);
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
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
          await queueChatMediaCleanup({
            conversationId,
            mediaAssetIds: result.mediaAssetIds,
          });
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
    { schema: { tags: ['Chat'], security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      try {
        const { payload } = await authenticate(request);
        const data = moderationSchema.parse(request.body);
        const conversationId = (request.params as any).id;
        const conversation = await getConversationForAccess(conversationId, payload.sub, payload.role);

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
