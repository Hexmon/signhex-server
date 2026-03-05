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

  async getOrCreateDm(userId: string, otherUserId: string) {
    const db = getDatabase();
    const pairKey = normalizeDmPair(userId, otherUserId);
    const [existing] = await db
      .select()
      .from(schema.chatConversations)
      .where(
        and(
          eq(schema.chatConversations.type, 'DM'),
          eq(schema.chatConversations.dm_pair_key, pairKey)
        )
      );

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

    if (existing) {
      await upsertMembers(existing.id);
      return existing;
    }

    const [created] = await db
      .insert(schema.chatConversations)
      .values({
        type: 'DM',
        dm_pair_key: pairKey,
        created_by: userId,
        invite_policy: 'INVITES_DISABLED',
        metadata: {},
      })
      .returning();

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
        metadata: {},
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
    const memberRows = await db
      .select({ conversation_id: schema.chatMembers.conversation_id })
      .from(schema.chatMembers)
      .where(
        and(
          eq(schema.chatMembers.user_id, userId),
          isNull(schema.chatMembers.left_at)
        )
      );

    const memberIds = memberRows.map((row) => row.conversation_id);
    const conditions = [eq(schema.chatConversations.state, 'ACTIVE')];
    if (memberIds.length) {
      conditions.push(
        or(
          inArray(schema.chatConversations.id, memberIds),
          eq(schema.chatConversations.type, 'FORUM_OPEN')
        ) as any
      );
    } else {
      conditions.push(eq(schema.chatConversations.type, 'FORUM_OPEN') as any);
    }

    const items = await db
      .select()
      .from(schema.chatConversations)
      .where(and(...conditions))
      .orderBy(desc(schema.chatConversations.updated_at));

    const conversations = [];
    for (const conversation of items) {
      const [lastMessage] = await db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.conversation_id, conversation.id))
        .orderBy(desc(schema.chatMessages.seq))
        .limit(1);
      const [receipt] = await db
        .select()
        .from(schema.chatReceipts)
        .where(
          and(
            eq(schema.chatReceipts.conversation_id, conversation.id),
            eq(schema.chatReceipts.user_id, userId)
          )
        );
      const readSeq = receipt?.last_read_seq ?? 0;
      const unreadRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.conversation_id, conversation.id),
            gt(schema.chatMessages.seq, readSeq),
            isNull(schema.chatMessages.deleted_at)
          )
        );

      conversations.push({
        ...conversation,
        last_message: lastMessage || null,
        unread_count: Number((unreadRows[0] as any)?.count || 0),
      });
    }

    return conversations;
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

      return updated;
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
