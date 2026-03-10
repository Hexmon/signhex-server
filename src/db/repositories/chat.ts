import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { AppError } from '@/utils/app-error';

type ConversationType = 'DM' | 'GROUP_CLOSED' | 'FORUM_OPEN';
type ConversationState = 'ACTIVE' | 'ARCHIVED' | 'DELETED';
type MemberRole = 'OWNER' | 'CHAT_ADMIN' | 'MOD' | 'MEMBER';
type ModerationAction = 'MUTE' | 'BAN' | 'UNMUTE' | 'UNBAN';
type BookmarkType = 'LINK' | 'FILE' | 'MESSAGE';

const INDEFINITE_UNTIL = new Date('9999-12-31T23:59:59.999Z');

function isAdminRole(roleName: string | undefined | null): boolean {
  return roleName === 'ADMIN' || roleName === 'SUPER_ADMIN';
}

function normalizeDmPair(a: string, b: string) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export class ChatRepository {
  async getConversationById(id: string) {
    const db = getDatabase();
    const [conversation] = await db
      .select()
      .from(schema.chatConversations)
      .where(eq(schema.chatConversations.id, id));
    return conversation || null;
  }

  async getMessageById(id: string) {
    const db = getDatabase();
    const [message] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, id));
    return message || null;
  }

  async getConversationForMessage(messageId: string) {
    const db = getDatabase();
    const [row] = await db
      .select({
        conversation: schema.chatConversations,
        message: schema.chatMessages,
      })
      .from(schema.chatMessages)
      .innerJoin(
        schema.chatConversations,
        eq(schema.chatMessages.conversation_id, schema.chatConversations.id)
      )
      .where(eq(schema.chatMessages.id, messageId));
    return row || null;
  }

  async getMember(conversationId: string, userId: string) {
    const db = getDatabase();
    const [member] = await db
      .select()
      .from(schema.chatMembers)
      .where(
        and(
          eq(schema.chatMembers.conversation_id, conversationId),
          eq(schema.chatMembers.user_id, userId),
          isNull(schema.chatMembers.left_at)
        )
      );
    return member || null;
  }

  async listMembers(conversationId: string) {
    const db = getDatabase();
    return db
      .select()
      .from(schema.chatMembers)
      .where(
        and(
          eq(schema.chatMembers.conversation_id, conversationId),
          isNull(schema.chatMembers.left_at)
        )
      );
  }

  async getModeration(conversationId: string, userId: string) {
    const db = getDatabase();
    const [row] = await db
      .select()
      .from(schema.chatModeration)
      .where(
        and(
          eq(schema.chatModeration.conversation_id, conversationId),
          eq(schema.chatModeration.user_id, userId)
        )
      );
    return row || null;
  }

  async getOrCreateDm(userId: string, otherUserId: string) {
    const db = getDatabase();
    const pairKey = normalizeDmPair(userId, otherUserId);
    const findActiveDm = async () => {
      const [row] = await db
        .select()
        .from(schema.chatConversations)
        .where(
          and(
            eq(schema.chatConversations.type, 'DM'),
            eq(schema.chatConversations.dm_pair_key, pairKey),
            eq(schema.chatConversations.state, 'ACTIVE')
          )
        )
        .limit(1);
      return row || null;
    };

    const upsertMembers = async (conversationId: string) => {
      await db
        .insert(schema.chatMembers)
        .values([
          {
            conversation_id: conversationId,
            user_id: userId,
            role: 'MEMBER',
            is_system: false,
          },
          {
            conversation_id: conversationId,
            user_id: otherUserId,
            role: 'MEMBER',
            is_system: false,
          },
        ])
        .onConflictDoNothing({
          target: [schema.chatMembers.conversation_id, schema.chatMembers.user_id],
        });
    };

    const existing = await findActiveDm();
    if (existing) {
      await upsertMembers(existing.id);
      return existing;
    }

    let created: typeof schema.chatConversations.$inferSelect | null = null;
    try {
      const [inserted] = await db
        .insert(schema.chatConversations)
        .values({
          type: 'DM',
          dm_pair_key: pairKey,
          created_by: userId,
          invite_policy: 'INVITES_DISABLED',
          metadata: {},
        })
        .returning();
      created = inserted || null;
    } catch (error: unknown) {
      const pgCode =
        typeof error === 'object' && error && 'code' in error
          ? (error as { code?: string }).code
          : undefined;
      if (pgCode !== '23505') throw error;
      created = await findActiveDm();
    }

    if (!created) {
      throw AppError.internal('Failed to create DM conversation');
    }

    await upsertMembers(created.id);
    return created;
  }

  async ensureSystemAdmins(conversationId: string) {
    const db = getDatabase();
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.roles, eq(schema.users.role_id, schema.roles.id))
      .where(
        and(
          eq(schema.users.is_active, true),
          inArray(schema.roles.name, ['ADMIN', 'SUPER_ADMIN'])
        )
      );

    if (!rows.length) return;

    await db
      .insert(schema.chatMembers)
      .values(
        rows.map((row) => ({
          conversation_id: conversationId,
          user_id: row.id,
          role: 'CHAT_ADMIN' as MemberRole,
          is_system: true,
        }))
      )
      .onConflictDoNothing({
        target: [schema.chatMembers.conversation_id, schema.chatMembers.user_id],
      });
  }

  async createConversation(input: {
    type: ConversationType;
    createdBy: string;
    title?: string;
    topic?: string;
    purpose?: string;
    invite_policy?: 'ANY_MEMBER_CAN_INVITE' | 'ADMINS_ONLY_CAN_INVITE' | 'INVITES_DISABLED';
    members?: string[];
    metadata?: Record<string, unknown>;
  }) {
    const db = getDatabase();
    const [conversation] = await db
      .insert(schema.chatConversations)
      .values({
        type: input.type,
        title: input.title,
        topic: input.topic,
        purpose: input.purpose,
        created_by: input.createdBy,
        invite_policy:
          input.type === 'DM'
            ? 'INVITES_DISABLED'
            : input.invite_policy || 'ANY_MEMBER_CAN_INVITE',
        metadata: input.metadata || {},
      })
      .returning();

    const members = Array.from(new Set([input.createdBy, ...(input.members || [])]));
    await db
      .insert(schema.chatMembers)
      .values(
        members.map((userId) => ({
          conversation_id: conversation.id,
          user_id: userId,
          role: userId === input.createdBy ? ('OWNER' as MemberRole) : ('MEMBER' as MemberRole),
          is_system: false,
        }))
      )
      .onConflictDoNothing({
        target: [schema.chatMembers.conversation_id, schema.chatMembers.user_id],
      });

    if (conversation.type !== 'DM') {
      await this.ensureSystemAdmins(conversation.id);
    }

    return conversation;
  }

  async canAccessConversation(
    conversationId: string,
    userId: string,
    roleName?: string
  ): Promise<boolean> {
    const conversation = await this.getConversationById(conversationId);
    if (!conversation || conversation.state === 'DELETED') return false;

    if (conversation.type === 'FORUM_OPEN') return true;

    const member = await this.getMember(conversationId, userId);
    if (member) return true;

    if (conversation.type !== 'DM' && isAdminRole(roleName)) return true;
    return false;
  }

  async isConversationAdmin(
    conversationId: string,
    userId: string,
    roleName?: string
  ): Promise<boolean> {
    const conversation = await this.getConversationById(conversationId);
    if (!conversation) return false;
    if (conversation.type !== 'DM' && isAdminRole(roleName)) return true;

    const member = await this.getMember(conversationId, userId);
    if (!member) return false;
    return member.role === 'OWNER' || member.role === 'CHAT_ADMIN' || member.role === 'MOD';
  }

  async listConversations(userId: string) {
    const db = getDatabase();
    const baseRows = await db
      .select({
        conversation: schema.chatConversations,
        member_role: schema.chatMembers.role,
        member_user_id: schema.chatMembers.user_id,
      })
      .from(schema.chatConversations)
      .leftJoin(
        schema.chatMembers,
        and(
          eq(schema.chatMembers.conversation_id, schema.chatConversations.id),
          eq(schema.chatMembers.user_id, userId),
          isNull(schema.chatMembers.left_at)
        )
      )
      .where(
        and(
          eq(schema.chatConversations.state, 'ACTIVE'),
          or(
            eq(schema.chatConversations.type, 'FORUM_OPEN'),
            eq(schema.chatMembers.user_id, userId)
          ) as any
        )
      )
      .orderBy(desc(schema.chatConversations.updated_at));

    const conversationIds = baseRows.map((row) => row.conversation.id);
    if (!conversationIds.length) return [];

    const lastSeqSubquery = db
      .select({
        conversation_id: schema.chatMessages.conversation_id,
        max_seq: sql<number>`max(${schema.chatMessages.seq})`.as('max_seq'),
      })
      .from(schema.chatMessages)
      .where(inArray(schema.chatMessages.conversation_id, conversationIds))
      .groupBy(schema.chatMessages.conversation_id)
      .as('last_seq_subquery');

    const lastMessageRows = await db
      .select({ message: schema.chatMessages })
      .from(lastSeqSubquery)
      .innerJoin(
        schema.chatMessages,
        and(
          eq(schema.chatMessages.conversation_id, lastSeqSubquery.conversation_id),
          eq(schema.chatMessages.seq, lastSeqSubquery.max_seq as any)
        )
      );
    const lastMessageByConversation = new Map(
      lastMessageRows.map((row) => [row.message.conversation_id, row.message])
    );

    const unreadRows = await db
      .select({
        conversation_id: schema.chatMessages.conversation_id,
        unread_count: sql<number>`count(*) FILTER (
          WHERE ${schema.chatMessages.deleted_at} IS NULL
            AND ${schema.chatMessages.seq} > COALESCE(${schema.chatReceipts.last_read_seq}, 0)
        )`,
      })
      .from(schema.chatMessages)
      .leftJoin(
        schema.chatReceipts,
        and(
          eq(schema.chatReceipts.conversation_id, schema.chatMessages.conversation_id),
          eq(schema.chatReceipts.user_id, userId)
        )
      )
      .where(inArray(schema.chatMessages.conversation_id, conversationIds))
      .groupBy(schema.chatMessages.conversation_id, schema.chatReceipts.last_read_seq);
    const unreadByConversation = new Map(
      unreadRows.map((row) => [row.conversation_id, Number(row.unread_count || 0)])
    );

    return baseRows.map((row) => ({
      ...row.conversation,
      last_message: lastMessageByConversation.get(row.conversation.id) || null,
      unread_count: unreadByConversation.get(row.conversation.id) || 0,
      viewer_role: row.member_role ?? null,
      viewer_is_member: Boolean(row.member_user_id),
    }));
  }

  async listMessages(
    conversationId: string,
    options: { afterSeq?: number; limit?: number; threadRootId?: string }
  ) {
    const db = getDatabase();
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 50;

    const conditions = [
      eq(schema.chatMessages.conversation_id, conversationId),
      gt(schema.chatMessages.seq, afterSeq),
    ];
    if (options.threadRootId) {
      conditions.push(eq(schema.chatMessages.thread_root_id, options.threadRootId));
    } else {
      conditions.push(
        or(
          isNull(schema.chatMessages.thread_root_id),
          eq(schema.chatMessages.also_to_channel, true)
        ) as any
      );
    }

    const items = await db
      .select()
      .from(schema.chatMessages)
      .where(and(...conditions))
      .orderBy(schema.chatMessages.seq)
      .limit(limit);

    const messageIds = items.map((i) => i.id);
    const attachments = messageIds.length
      ? await db
          .select()
          .from(schema.chatAttachments)
          .where(inArray(schema.chatAttachments.message_id, messageIds))
      : [];
    const reactions = messageIds.length
      ? await db
          .select()
          .from(schema.chatReactions)
          .where(inArray(schema.chatReactions.message_id, messageIds))
      : [];

    const attMap = new Map<string, any[]>();
    for (const attachment of attachments) {
      const list = attMap.get(attachment.message_id) || [];
      list.push(attachment);
      attMap.set(attachment.message_id, list);
    }

    const reactMap = new Map<string, any[]>();
    for (const reaction of reactions) {
      const list = reactMap.get(reaction.message_id) || [];
      list.push(reaction);
      reactMap.set(reaction.message_id, list);
    }

    return items.map((item) => {
      if (item.deleted_at) {
        return {
          ...item,
          body_text: null,
          body_rich: null,
          attachments: [],
          reactions: [],
        };
      }

      return {
        ...item,
        attachments: attMap.get(item.id) || [],
        reactions: reactMap.get(item.id) || [],
      };
    });
  }

  async sendMessageTx(input: {
    conversationId: string;
    senderId: string;
    bodyText?: string;
    bodyRich?: unknown;
    replyToMessageId?: string;
    alsoToChannel?: boolean;
    attachmentMediaIds?: string[];
  }) {
    const db = getDatabase();
    return db.transaction(async (tx) => {
      const [conversation] = await tx
        .select()
        .from(schema.chatConversations)
        .where(eq(schema.chatConversations.id, input.conversationId));
      if (!conversation) throw AppError.notFound('Conversation not found');
      if (conversation.state !== 'ACTIVE') throw AppError.conflict('Conversation is not active');

      let threadRootId: string | null = null;
      let threadRootSenderId: string | null = null;
      if (input.replyToMessageId) {
        const [parentMessage] = await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.id, input.replyToMessageId));
        if (!parentMessage || parentMessage.conversation_id !== input.conversationId) {
          throw AppError.badRequest('replyTo message is invalid');
        }
        threadRootId = parentMessage.thread_root_id || parentMessage.id;
        threadRootSenderId = parentMessage.sender_id;
      }

      const [seqRow] = await tx
        .update(schema.chatConversations)
        .set({
          last_seq: sql`${schema.chatConversations.last_seq} + 1`,
          updated_at: new Date(),
        })
        .where(eq(schema.chatConversations.id, input.conversationId))
        .returning({ seq: schema.chatConversations.last_seq });

      const nextSeq = seqRow?.seq;
      if (!nextSeq) throw AppError.internal('Failed to allocate sequence');

      const [message] = await tx
        .insert(schema.chatMessages)
        .values({
          conversation_id: input.conversationId,
          seq: nextSeq,
          sender_id: input.senderId,
          body_text: input.bodyText,
          body_rich: input.bodyRich as any,
          also_to_channel: Boolean(input.alsoToChannel),
          reply_to_message_id: input.replyToMessageId,
          thread_root_id: threadRootId,
        })
        .returning();

      if (threadRootId) {
        await tx
          .update(schema.chatMessages)
          .set({
            thread_reply_count: sql`${schema.chatMessages.thread_reply_count} + 1`,
          })
          .where(eq(schema.chatMessages.id, threadRootId));
      }

      if (input.attachmentMediaIds?.length) {
        await tx.insert(schema.chatAttachments).values(
          input.attachmentMediaIds.map((mediaAssetId, index) => ({
            message_id: message.id,
            media_asset_id: mediaAssetId,
            ord: index,
          }))
        );
      }

      return { conversation, message, threadRootSenderId };
    });
  }

  async editMessage(input: { messageId: string; editorId: string; newBodyText: string; newBodyRich?: unknown }) {
    const db = getDatabase();
    return db.transaction(async (tx) => {
      const [message] = await tx
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, input.messageId));
      if (!message) throw AppError.notFound('Message not found');

      await tx.insert(schema.chatMessageRevisions).values({
        message_id: message.id,
        editor_id: input.editorId,
        action: 'EDIT',
        old_body_text: message.body_text,
        old_body_rich: message.body_rich,
        new_body_text: input.newBodyText,
        new_body_rich: input.newBodyRich as any,
      });

      const [updated] = await tx
        .update(schema.chatMessages)
        .set({
          body_text: input.newBodyText,
          body_rich: (input.newBodyRich as any) ?? message.body_rich,
          edited_at: new Date(),
        })
        .where(eq(schema.chatMessages.id, input.messageId))
        .returning();

      return updated;
    });
  }

  async softDeleteMessage(input: { messageId: string; editorId: string }) {
    const db = getDatabase();
    return db.transaction(async (tx) => {
      const [message] = await tx
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, input.messageId));
      if (!message) throw AppError.notFound('Message not found');

      const attachments = await tx
        .select({ media_asset_id: schema.chatAttachments.media_asset_id })
        .from(schema.chatAttachments)
        .where(eq(schema.chatAttachments.message_id, input.messageId));
      const detachedMediaAssetIds = Array.from(
        new Set(attachments.map((attachment) => attachment.media_asset_id))
      );

      await tx.insert(schema.chatMessageRevisions).values({
        message_id: message.id,
        editor_id: input.editorId,
        action: 'DELETE',
        old_body_text: message.body_text,
        old_body_rich: message.body_rich,
      });

      const [updated] = await tx
        .update(schema.chatMessages)
        .set({
          deleted_at: new Date(),
          edited_at: new Date(),
          body_text: null,
          body_rich: null,
        })
        .where(eq(schema.chatMessages.id, input.messageId))
        .returning();

      if (attachments.length > 0) {
        await tx
          .delete(schema.chatAttachments)
          .where(eq(schema.chatAttachments.message_id, input.messageId));
      }

      return {
        message: updated,
        detachedMediaAssetIds,
      };
    });
  }

  async updateReaction(input: {
    messageId: string;
    userId: string;
    emoji: string;
    op: 'add' | 'remove';
  }) {
    const db = getDatabase();
    const [message] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, input.messageId));
    if (!message) throw AppError.notFound('Message not found');

    if (input.op === 'add') {
      await db
        .insert(schema.chatReactions)
        .values({
          message_id: input.messageId,
          user_id: input.userId,
          emoji: input.emoji,
        })
        .onConflictDoNothing({
          target: [
            schema.chatReactions.message_id,
            schema.chatReactions.user_id,
            schema.chatReactions.emoji,
          ],
        });
    } else {
      await db
        .delete(schema.chatReactions)
        .where(
          and(
            eq(schema.chatReactions.message_id, input.messageId),
            eq(schema.chatReactions.user_id, input.userId),
            eq(schema.chatReactions.emoji, input.emoji)
          )
        );
    }

    const reactions = await db
      .select()
      .from(schema.chatReactions)
      .where(eq(schema.chatReactions.message_id, input.messageId));

    return { message, reactions };
  }

  async pinMessage(input: { conversationId: string; messageId: string; pinnedBy: string }) {
    const db = getDatabase();
    const [message] = await db
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.id, input.messageId),
          eq(schema.chatMessages.conversation_id, input.conversationId)
        )
      );
    if (!message) throw AppError.notFound('Message not found');
    if (message.deleted_at) throw AppError.badRequest('Deleted message cannot be pinned');

    const [pin] = await db
      .insert(schema.chatPins)
      .values({
        conversation_id: input.conversationId,
        message_id: input.messageId,
        pinned_by: input.pinnedBy,
      })
      .onConflictDoUpdate({
        target: [schema.chatPins.conversation_id, schema.chatPins.message_id],
        set: {
          pinned_by: input.pinnedBy,
          pinned_at: new Date(),
        },
      })
      .returning();

    return pin;
  }

  async unpinMessage(conversationId: string, messageId: string) {
    const db = getDatabase();
    const rows = await db
      .delete(schema.chatPins)
      .where(
        and(
          eq(schema.chatPins.conversation_id, conversationId),
          eq(schema.chatPins.message_id, messageId)
        )
      )
      .returning({ id: schema.chatPins.id });
    return rows.length > 0;
  }

  async listPins(conversationId: string) {
    const db = getDatabase();
    const rows = await db
      .select({
        pin: schema.chatPins,
        message: schema.chatMessages,
      })
      .from(schema.chatPins)
      .innerJoin(schema.chatMessages, eq(schema.chatPins.message_id, schema.chatMessages.id))
      .where(eq(schema.chatPins.conversation_id, conversationId))
      .orderBy(desc(schema.chatPins.pinned_at));

    return rows.map((row) => ({
      ...row.pin,
      message: row.message.deleted_at
        ? {
            ...row.message,
            body_text: null,
            body_rich: null,
          }
        : row.message,
    }));
  }

  async createBookmark(input: {
    conversationId: string;
    type: BookmarkType;
    label: string;
    emoji?: string;
    url?: string;
    mediaAssetId?: string;
    messageId?: string;
    createdBy: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ bookmark: typeof schema.chatBookmarks.$inferSelect; created: boolean }> {
    const db = getDatabase();
    if (input.type === 'LINK' && !input.url) {
      throw AppError.badRequest('url is required for LINK bookmark');
    }
    if (input.type === 'FILE' && !input.mediaAssetId) {
      throw AppError.badRequest('mediaAssetId is required for FILE bookmark');
    }
    if (input.type === 'MESSAGE' && !input.messageId) {
      throw AppError.badRequest('messageId is required for MESSAGE bookmark');
    }

    if (input.messageId) {
      const [message] = await db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.id, input.messageId));
      if (!message || message.conversation_id !== input.conversationId) {
        throw AppError.badRequest('messageId is invalid for this conversation');
      }
    }

    const uniqueTargetCondition =
      input.type === 'LINK'
        ? and(
            eq(schema.chatBookmarks.conversation_id, input.conversationId),
            eq(schema.chatBookmarks.type, 'LINK'),
            eq(schema.chatBookmarks.url, input.url!)
          )
        : input.type === 'FILE'
          ? and(
              eq(schema.chatBookmarks.conversation_id, input.conversationId),
              eq(schema.chatBookmarks.type, 'FILE'),
              eq(schema.chatBookmarks.media_asset_id, input.mediaAssetId!)
            )
          : and(
              eq(schema.chatBookmarks.conversation_id, input.conversationId),
              eq(schema.chatBookmarks.type, 'MESSAGE'),
              eq(schema.chatBookmarks.message_id, input.messageId!)
            );

    const [existing] = await db
      .select()
      .from(schema.chatBookmarks)
      .where(uniqueTargetCondition)
      .orderBy(desc(schema.chatBookmarks.created_at))
      .limit(1);
    if (existing) {
      return { bookmark: existing, created: false };
    }

    const [bookmark] = await db
      .insert(schema.chatBookmarks)
      .values({
        conversation_id: input.conversationId,
        type: input.type,
        label: input.label,
        emoji: input.emoji,
        url: input.url,
        media_asset_id: input.mediaAssetId,
        message_id: input.messageId,
        created_by: input.createdBy,
        metadata: input.metadata,
      })
      .returning();

    return { bookmark, created: true };
  }

  async listBookmarks(conversationId: string) {
    const db = getDatabase();
    return db
      .select()
      .from(schema.chatBookmarks)
      .where(eq(schema.chatBookmarks.conversation_id, conversationId))
      .orderBy(desc(schema.chatBookmarks.created_at));
  }

  async getBookmarkById(id: string) {
    const db = getDatabase();
    const [bookmark] = await db
      .select()
      .from(schema.chatBookmarks)
      .where(eq(schema.chatBookmarks.id, id));
    return bookmark || null;
  }

  async deleteBookmark(id: string) {
    const db = getDatabase();
    const [deleted] = await db
      .delete(schema.chatBookmarks)
      .where(eq(schema.chatBookmarks.id, id))
      .returning();
    return deleted || null;
  }

  async markRead(conversationId: string, userId: string, lastReadSeq: number) {
    const db = getDatabase();
    const [receipt] = await db
      .insert(schema.chatReceipts)
      .values({
        conversation_id: conversationId,
        user_id: userId,
        last_read_seq: lastReadSeq,
        last_delivered_seq: lastReadSeq,
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.chatReceipts.conversation_id, schema.chatReceipts.user_id],
        set: {
          last_read_seq: sql`GREATEST(${schema.chatReceipts.last_read_seq}, ${lastReadSeq})`,
          last_delivered_seq: sql`GREATEST(${schema.chatReceipts.last_delivered_seq}, ${lastReadSeq})`,
          updated_at: new Date(),
        },
      })
      .returning();

    return receipt;
  }

  async applyModerationAction(input: {
    conversationId: string;
    userId: string;
    action: ModerationAction;
    until?: Date;
    reason?: string;
  }) {
    const db = getDatabase();
    const [existing] = await db
      .select()
      .from(schema.chatModeration)
      .where(
        and(
          eq(schema.chatModeration.conversation_id, input.conversationId),
          eq(schema.chatModeration.user_id, input.userId)
        )
      );

    if (input.action === 'UNMUTE' || input.action === 'UNBAN') {
      if (!existing) return null;
      const [updated] = await db
        .update(schema.chatModeration)
        .set({
          muted_until: input.action === 'UNMUTE' ? null : existing.muted_until,
          banned_until: input.action === 'UNBAN' ? null : existing.banned_until,
          reason: input.reason ?? existing.reason,
          updated_at: new Date(),
        })
        .where(eq(schema.chatModeration.id, existing.id))
        .returning();
      return updated || null;
    }

    const until = input.until ?? INDEFINITE_UNTIL;
    if (until.getTime() <= Date.now()) {
      throw AppError.badRequest('Moderation expiry must be in the future');
    }

    if (existing) {
      const [updated] = await db
        .update(schema.chatModeration)
        .set({
          muted_until: input.action === 'MUTE' ? until : existing.muted_until,
          banned_until: input.action === 'BAN' ? until : existing.banned_until,
          reason: input.reason ?? existing.reason,
          updated_at: new Date(),
        })
        .where(eq(schema.chatModeration.id, existing.id))
        .returning();
      return updated || null;
    }

    const [created] = await db
      .insert(schema.chatModeration)
      .values({
        conversation_id: input.conversationId,
        user_id: input.userId,
        muted_until: input.action === 'MUTE' ? until : null,
        banned_until: input.action === 'BAN' ? until : null,
        reason: input.reason ?? null,
        updated_at: new Date(),
      })
      .returning();
    return created || null;
  }

  async inviteMembers(conversationId: string, userIds: string[], role: MemberRole = 'MEMBER') {
    const db = getDatabase();
    if (!userIds.length) return;

    await db
      .insert(schema.chatMembers)
      .values(
        userIds.map((userId) => ({
          conversation_id: conversationId,
          user_id: userId,
          role,
          is_system: false,
          left_at: null,
        }))
      )
      .onConflictDoUpdate({
        target: [schema.chatMembers.conversation_id, schema.chatMembers.user_id],
        set: {
          left_at: null,
          role,
        },
      });
  }

  async removeMember(conversationId: string, userId: string) {
    const db = getDatabase();
    const [member] = await db
      .select()
      .from(schema.chatMembers)
      .where(
        and(
          eq(schema.chatMembers.conversation_id, conversationId),
          eq(schema.chatMembers.user_id, userId),
          isNull(schema.chatMembers.left_at)
        )
      );
    if (!member) throw AppError.notFound('Member not found');
    if (member.is_system) throw AppError.forbidden('System member cannot be removed');

    await db
      .update(schema.chatMembers)
      .set({ left_at: new Date() })
      .where(eq(schema.chatMembers.id, member.id));
  }

  async updateConversation(
    conversationId: string,
    patch: Partial<{
      title: string;
      topic: string;
      purpose: string;
      invite_policy: 'ANY_MEMBER_CAN_INVITE' | 'ADMINS_ONLY_CAN_INVITE' | 'INVITES_DISABLED';
      state: ConversationState;
      metadata: Record<string, unknown>;
    }>
  ) {
    const db = getDatabase();
    const [updated] = await db
      .update(schema.chatConversations)
      .set({
        ...patch,
        updated_at: new Date(),
      })
      .where(eq(schema.chatConversations.id, conversationId))
      .returning();

    return updated || null;
  }

  async archiveConversation(conversationId: string) {
    const db = getDatabase();
    const [updated] = await db
      .update(schema.chatConversations)
      .set({
        state: 'ARCHIVED',
        archived_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(schema.chatConversations.id, conversationId))
      .returning();
    return updated || null;
  }

  async unarchiveConversation(conversationId: string) {
    const db = getDatabase();
    const [updated] = await db
      .update(schema.chatConversations)
      .set({
        state: 'ACTIVE',
        archived_at: null,
        updated_at: new Date(),
      })
      .where(eq(schema.chatConversations.id, conversationId))
      .returning();
    return updated || null;
  }

  async hardDeleteConversation(conversationId: string) {
    const db = getDatabase();
    return db.transaction(async (tx) => {
      const [conversation] = await tx
        .select()
        .from(schema.chatConversations)
        .where(eq(schema.chatConversations.id, conversationId));
      if (!conversation) throw AppError.notFound('Conversation not found');

      const messageIdsRows = await tx
        .select({ id: schema.chatMessages.id })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.conversation_id, conversationId));
      const messageIds = messageIdsRows.map((row) => row.id);

      const mediaRows = messageIds.length
        ? await tx
            .select({ media_asset_id: schema.chatAttachments.media_asset_id })
            .from(schema.chatAttachments)
            .where(inArray(schema.chatAttachments.message_id, messageIds))
        : [];
      const mediaAssetIds = Array.from(new Set(mediaRows.map((row) => row.media_asset_id)));

      if (messageIds.length) {
        await tx
          .delete(schema.chatReactions)
          .where(inArray(schema.chatReactions.message_id, messageIds));
        await tx
          .delete(schema.chatAttachments)
          .where(inArray(schema.chatAttachments.message_id, messageIds));
        await tx
          .delete(schema.chatMessageRevisions)
          .where(inArray(schema.chatMessageRevisions.message_id, messageIds));
      }

      await tx
        .delete(schema.chatMessages)
        .where(eq(schema.chatMessages.conversation_id, conversationId));
      await tx
        .delete(schema.chatReceipts)
        .where(eq(schema.chatReceipts.conversation_id, conversationId));
      await tx
        .delete(schema.chatModeration)
        .where(eq(schema.chatModeration.conversation_id, conversationId));
      await tx
        .delete(schema.chatMembers)
        .where(eq(schema.chatMembers.conversation_id, conversationId));
      await tx
        .delete(schema.chatPins)
        .where(eq(schema.chatPins.conversation_id, conversationId));
      await tx
        .delete(schema.chatBookmarks)
        .where(eq(schema.chatBookmarks.conversation_id, conversationId));

      const [updated] = await tx
        .update(schema.chatConversations)
        .set({
          state: 'DELETED',
          deleted_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(schema.chatConversations.id, conversationId))
        .returning();

      return { conversation: updated, mediaAssetIds };
    });
  }
}

export function createChatRepository() {
  return new ChatRepository();
}
