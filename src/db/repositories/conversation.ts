import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { AppError } from '@/utils/app-error';
import { createChatRepository } from '@/db/repositories/chat';

export class ConversationRepository {
  // Legacy /conversations shim: DM data is sourced from chat_* tables.
  private chatRepo = createChatRepository();

  private orderParticipants(a: string, b: string) {
    return a < b ? { a, b } : { a: b, b: a };
  }

  private parseDmPair(pairKey: string | null) {
    if (!pairKey) return null;
    const [a, b] = pairKey.split(':');
    if (!a || !b) return null;
    return this.orderParticipants(a, b);
  }

  private toLegacyConversation(chatConversation: typeof schema.chatConversations.$inferSelect) {
    const ordered = this.parseDmPair(chatConversation.dm_pair_key);
    if (!ordered) throw AppError.internal('Invalid DM pair key');
    return {
      id: chatConversation.id,
      participant_a: ordered.a,
      participant_b: ordered.b,
      created_at: chatConversation.created_at,
      updated_at: chatConversation.updated_at,
    };
  }

  private extractLegacyAttachments(
    message: typeof schema.chatMessages.$inferSelect,
    chatAttachments: Array<typeof schema.chatAttachments.$inferSelect>
  ) {
    if (message.deleted_at) return [];

    const rich = message.body_rich as Record<string, unknown> | null;
    const legacyAttachments = rich?.legacy_attachments;
    if (Array.isArray(legacyAttachments)) return legacyAttachments;

    return chatAttachments.map((attachment) => ({
      media_asset_id: attachment.media_asset_id,
      kind: attachment.kind,
      ord: attachment.ord,
      metadata: attachment.metadata,
    }));
  }

  private extractMediaIds(attachments?: any[]) {
    if (!attachments?.length) return [] as string[];
    const mediaIds = new Set<string>();
    for (const attachment of attachments) {
      if (typeof attachment === 'string') {
        mediaIds.add(attachment);
        continue;
      }
      if (!attachment || typeof attachment !== 'object') continue;
      const candidate =
        (attachment as any).mediaAssetId ||
        (attachment as any).media_asset_id ||
        (attachment as any).id;
      if (typeof candidate === 'string' && candidate.length > 0) {
        mediaIds.add(candidate);
      }
    }
    return Array.from(mediaIds);
  }

  private async resolveDmConversationForUser(conversationId: string, userId: string) {
    const db = getDatabase();

    const [direct] = await db
      .select()
      .from(schema.chatConversations)
      .where(
        and(
          eq(schema.chatConversations.id, conversationId),
          eq(schema.chatConversations.type, 'DM'),
          eq(schema.chatConversations.state, 'ACTIVE')
        )
      )
      .limit(1);

    if (direct) {
      const member = await this.chatRepo.getMember(direct.id, userId);
      if (!member) throw AppError.forbidden('Forbidden');
      return direct;
    }

    const [legacyConversation] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .limit(1);
    if (!legacyConversation) throw AppError.notFound('Conversation not found');
    if (
      legacyConversation.participant_a !== userId &&
      legacyConversation.participant_b !== userId
    ) {
      throw AppError.forbidden('Forbidden');
    }

    const ensured = await this.chatRepo.getOrCreateDm(
      legacyConversation.participant_a,
      legacyConversation.participant_b
    );
    return ensured;
  }

  async getOrCreate(participantA: string, participantB: string) {
    const conversation = await this.chatRepo.getOrCreateDm(participantA, participantB);
    return this.toLegacyConversation(conversation);
  }

  async listForUser(userId: string) {
    const db = getDatabase();
    const legacyItems = await db
      .select()
      .from(schema.conversations)
      .where(or(eq(schema.conversations.participant_a, userId), eq(schema.conversations.participant_b, userId)))
      .orderBy(desc(schema.conversations.updated_at))
      .limit(500);

    for (const legacyConversation of legacyItems) {
      await this.chatRepo.getOrCreateDm(legacyConversation.participant_a, legacyConversation.participant_b);
    }

    const rows = await db
      .select({ conversation: schema.chatConversations })
      .from(schema.chatConversations)
      .innerJoin(
        schema.chatMembers,
        and(
          eq(schema.chatMembers.conversation_id, schema.chatConversations.id),
          eq(schema.chatMembers.user_id, userId),
          isNull(schema.chatMembers.left_at)
        )
      )
      .where(
        and(
          eq(schema.chatConversations.type, 'DM'),
          eq(schema.chatConversations.state, 'ACTIVE')
        )
      )
      .orderBy(desc(schema.chatConversations.updated_at));

    const items = rows.map((row) => this.toLegacyConversation(row.conversation));
    return items;
  }

  async addMessage(conversationId: string, authorId: string, content: string, attachments?: any[]) {
    const conversation = await this.resolveDmConversationForUser(conversationId, authorId);
    const mediaIds = this.extractMediaIds(attachments);
    const richBody = attachments?.length ? { legacy_attachments: attachments } : undefined;

    const { message } = await this.chatRepo.sendMessageTx({
      conversationId: conversation.id,
      senderId: authorId,
      bodyText: content,
      bodyRich: richBody,
      attachmentMediaIds: mediaIds,
    });

    return {
      id: message.id,
      conversation_id: message.conversation_id,
      author_id: message.sender_id,
      content: message.body_text ?? '',
      attachments: attachments ?? [],
      created_at: message.created_at,
    };
  }

  async listMessages(conversationId: string, page = 1, limit = 50, userId?: string) {
    const db = getDatabase();
    if (!userId) throw AppError.forbidden('Forbidden');
    const conversation = await this.resolveDmConversationForUser(conversationId, userId);
    const offset = (page - 1) * limit;
    const items = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.conversation_id, conversation.id))
      .orderBy(desc(schema.chatMessages.created_at))
      .limit(limit)
      .offset(offset);

    const messageIds = items.map((message) => message.id);
    const chatAttachments = messageIds.length
      ? await db
          .select()
          .from(schema.chatAttachments)
          .where(inArray(schema.chatAttachments.message_id, messageIds))
      : [];
    const attachmentsMap = new Map<string, Array<typeof schema.chatAttachments.$inferSelect>>();
    for (const attachment of chatAttachments) {
      const bucket = attachmentsMap.get(attachment.message_id) || [];
      bucket.push(attachment);
      attachmentsMap.set(attachment.message_id, bucket);
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.conversation_id, conversation.id));

    const mapped = items.map((item) => ({
      id: item.id,
      conversation_id: item.conversation_id,
      author_id: item.sender_id,
      content: item.deleted_at ? '' : item.body_text ?? '',
      attachments: this.extractLegacyAttachments(item, attachmentsMap.get(item.id) || []),
      created_at: item.created_at,
    }));

    return { items: mapped, total: Number(count || 0), page, limit };
  }

  async markRead(conversationId: string, userId: string) {
    const conversation = await this.resolveDmConversationForUser(conversationId, userId);
    const receipt = await this.chatRepo.markRead(conversation.id, userId, conversation.last_seq);
    return {
      id: receipt.id,
      conversation_id: receipt.conversation_id,
      user_id: receipt.user_id,
      last_read_at: new Date(),
      created_at: receipt.updated_at,
      updated_at: receipt.updated_at,
    };
  }
}

export function createConversationRepository(): ConversationRepository {
  return new ConversationRepository();
}
