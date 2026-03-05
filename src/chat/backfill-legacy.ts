import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { AppError } from '@/utils/app-error';
import { createLogger } from '@/utils/logger';

const logger = createLogger('chat-legacy-backfill');

function orderedParticipants(a: string, b: string) {
  return a < b ? { a, b } : { a: b, b: a };
}

function dmPairKey(a: string, b: string) {
  const ordered = orderedParticipants(a, b);
  return `${ordered.a}:${ordered.b}`;
}

export type ChatLegacyBackfillStats = {
  conversationsScanned: number;
  conversationsCreated: number;
  conversationsReactivated: number;
  membersUpserted: number;
  messagesBackfilled: number;
  receiptsUpserted: number;
};

export async function backfillLegacyConversationsToChat(): Promise<ChatLegacyBackfillStats> {
  const db = getDatabase();
  const legacyConversations = await db
    .select()
    .from(schema.conversations)
    .orderBy(asc(schema.conversations.created_at), asc(schema.conversations.id));

  const stats: ChatLegacyBackfillStats = {
    conversationsScanned: legacyConversations.length,
    conversationsCreated: 0,
    conversationsReactivated: 0,
    membersUpserted: 0,
    messagesBackfilled: 0,
    receiptsUpserted: 0,
  };

  for (const legacyConversation of legacyConversations) {
    const pairKey = dmPairKey(legacyConversation.participant_a, legacyConversation.participant_b);

    await db.transaction(async (tx) => {
      let [targetConversation] = await tx
        .select()
        .from(schema.chatConversations)
        .where(
          and(
            eq(schema.chatConversations.type, 'DM'),
            eq(schema.chatConversations.dm_pair_key, pairKey),
            or(
              eq(schema.chatConversations.state, 'ACTIVE'),
              eq(schema.chatConversations.state, 'ARCHIVED')
            )
          )
        )
        .limit(1);

      if (!targetConversation) {
        const [created] = await tx
          .insert(schema.chatConversations)
          .values({
            id: legacyConversation.id,
            type: 'DM',
            dm_pair_key: pairKey,
            created_by: legacyConversation.participant_a,
            state: 'ACTIVE',
            invite_policy: 'INVITES_DISABLED',
            last_seq: 0,
            metadata: {},
            created_at: legacyConversation.created_at,
            updated_at: legacyConversation.updated_at,
          })
          .onConflictDoNothing({
            target: schema.chatConversations.id,
          })
          .returning();

        if (created) {
          targetConversation = created;
          stats.conversationsCreated += 1;
        } else {
          const [existing] = await tx
            .select()
            .from(schema.chatConversations)
            .where(
              and(
                eq(schema.chatConversations.type, 'DM'),
                eq(schema.chatConversations.dm_pair_key, pairKey),
                or(
                  eq(schema.chatConversations.state, 'ACTIVE'),
                  eq(schema.chatConversations.state, 'ARCHIVED')
                )
              )
            )
            .limit(1);
          targetConversation = existing;
        }
      }

      if (!targetConversation) {
        throw AppError.internal(`Unable to resolve DM conversation for pair ${pairKey}`);
      }

      if (targetConversation.state !== 'ACTIVE') {
        const [reactivated] = await tx
          .update(schema.chatConversations)
          .set({
            state: 'ACTIVE',
            archived_at: null,
            updated_at: new Date(),
          })
          .where(eq(schema.chatConversations.id, targetConversation.id))
          .returning();
        if (reactivated) {
          targetConversation = reactivated;
          stats.conversationsReactivated += 1;
        }
      }

      const memberValues = [
        {
          conversation_id: targetConversation.id,
          user_id: legacyConversation.participant_a,
          role: 'MEMBER' as const,
          is_system: false,
          joined_at: legacyConversation.created_at,
          left_at: null,
          created_at: legacyConversation.created_at,
        },
        {
          conversation_id: targetConversation.id,
          user_id: legacyConversation.participant_b,
          role: 'MEMBER' as const,
          is_system: false,
          joined_at: legacyConversation.created_at,
          left_at: null,
          created_at: legacyConversation.created_at,
        },
      ];

      const existingMembers = await tx
        .select({ user_id: schema.chatMembers.user_id })
        .from(schema.chatMembers)
        .where(
          and(
            eq(schema.chatMembers.conversation_id, targetConversation.id),
            isNull(schema.chatMembers.left_at)
          )
        );
      const existingMemberIds = new Set(existingMembers.map((row) => row.user_id));

      for (const member of memberValues) {
        if (!existingMemberIds.has(member.user_id)) {
          await tx
            .insert(schema.chatMembers)
            .values(member)
            .onConflictDoUpdate({
              target: [schema.chatMembers.conversation_id, schema.chatMembers.user_id],
              set: {
                left_at: null,
                role: member.role,
                is_system: false,
              },
            });
          stats.membersUpserted += 1;
        }
      }

      const legacyMessages = await tx
        .select()
        .from(schema.conversationMessages)
        .where(eq(schema.conversationMessages.conversation_id, legacyConversation.id))
        .orderBy(asc(schema.conversationMessages.created_at), asc(schema.conversationMessages.id));

      for (const legacyMessage of legacyMessages) {
        const [existingMessage] = await tx
          .select({ id: schema.chatMessages.id })
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.id, legacyMessage.id))
          .limit(1);
        if (existingMessage) continue;

        const [seqRow] = await tx
          .update(schema.chatConversations)
          .set({
            last_seq: sql`${schema.chatConversations.last_seq} + 1`,
            updated_at: new Date(),
          })
          .where(eq(schema.chatConversations.id, targetConversation.id))
          .returning({ seq: schema.chatConversations.last_seq });
        const nextSeq = Number(seqRow?.seq || 0);
        if (!nextSeq) throw AppError.internal('Failed to allocate chat sequence during backfill');

        await tx.insert(schema.chatMessages).values({
          id: legacyMessage.id,
          conversation_id: targetConversation.id,
          seq: nextSeq,
          sender_id: legacyMessage.author_id,
          body_text: legacyMessage.content,
          body_rich: legacyMessage.attachments
            ? { legacy_attachments: legacyMessage.attachments }
            : null,
          created_at: legacyMessage.created_at,
        });
        stats.messagesBackfilled += 1;
      }

      const [maxSeqRow] = await tx
        .select({ maxSeq: sql<number>`COALESCE(MAX(${schema.chatMessages.seq}), 0)` })
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.conversation_id, targetConversation.id));
      const maxSeq = Number(maxSeqRow?.maxSeq || 0);

      await tx
        .update(schema.chatConversations)
        .set({
          last_seq: maxSeq,
          updated_at:
            targetConversation.updated_at > legacyConversation.updated_at
              ? targetConversation.updated_at
              : legacyConversation.updated_at,
        })
        .where(eq(schema.chatConversations.id, targetConversation.id));

      const legacyReads = await tx
        .select()
        .from(schema.conversationReads)
        .where(eq(schema.conversationReads.conversation_id, legacyConversation.id));

      for (const legacyRead of legacyReads) {
        const [readSeqRow] = await tx
          .select({
            readSeq: legacyRead.last_read_at
              ? sql<number>`COALESCE(MAX(${schema.chatMessages.seq}), 0)`
              : sql<number>`0`,
          })
          .from(schema.chatMessages)
          .where(
            legacyRead.last_read_at
              ? and(
                  eq(schema.chatMessages.conversation_id, targetConversation.id),
                  sql`${schema.chatMessages.created_at} <= ${legacyRead.last_read_at}`
                )
              : eq(schema.chatMessages.conversation_id, targetConversation.id)
          );
        const readSeq = Number(readSeqRow?.readSeq || 0);

        await tx
          .insert(schema.chatReceipts)
          .values({
            conversation_id: targetConversation.id,
            user_id: legacyRead.user_id,
            last_read_seq: readSeq,
            last_delivered_seq: maxSeq,
            updated_at: legacyRead.updated_at ?? legacyRead.created_at ?? new Date(),
          })
          .onConflictDoUpdate({
            target: [schema.chatReceipts.conversation_id, schema.chatReceipts.user_id],
            set: {
              last_read_seq: sql`GREATEST(${schema.chatReceipts.last_read_seq}, ${readSeq})`,
              last_delivered_seq: sql`GREATEST(${schema.chatReceipts.last_delivered_seq}, ${maxSeq})`,
              updated_at: legacyRead.updated_at ?? legacyRead.created_at ?? new Date(),
            },
          });
        stats.receiptsUpserted += 1;
      }
    });
  }

  logger.info(stats, 'Legacy conversations backfill completed');
  return stats;
}
