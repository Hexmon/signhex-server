import { and, desc, eq, or } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class ConversationRepository {
  private orderParticipants(a: string, b: string) {
    return a < b ? { a, b } : { a: b, b: a };
  }

  async getOrCreate(participantA: string, participantB: string) {
    const db = getDatabase();
    const { a, b } = this.orderParticipants(participantA, participantB);
    const existing = await db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.participant_a, a), eq(schema.conversations.participant_b, b)));
    if (existing[0]) return existing[0];

    const [created] = await db
      .insert(schema.conversations)
      .values({ participant_a: a, participant_b: b })
      .returning();
    return created;
  }

  async listForUser(userId: string) {
    const db = getDatabase();
    const items = await db
      .select()
      .from(schema.conversations)
      .where(or(eq(schema.conversations.participant_a, userId), eq(schema.conversations.participant_b, userId)))
      .orderBy(desc(schema.conversations.updated_at));
    return items;
  }

  async addMessage(conversationId: string, authorId: string, content: string, attachments?: any[]) {
    const db = getDatabase();
    const [message] = await db
      .insert(schema.conversationMessages)
      .values({
        conversation_id: conversationId,
        author_id: authorId,
        content,
        attachments: attachments ?? [],
      })
      .returning();

    await db
      .update(schema.conversations)
      .set({ updated_at: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    return message;
  }

  async listMessages(conversationId: string, page = 1, limit = 50) {
    const db = getDatabase();
    const offset = (page - 1) * limit;
    const items = await db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversation_id, conversationId))
      .orderBy(desc(schema.conversationMessages.created_at))
      .limit(limit)
      .offset(offset);
    const total = await db
      .select()
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversation_id, conversationId));
    return { items, total: total.length, page, limit };
  }

  async markRead(conversationId: string, userId: string) {
    const db = getDatabase();
    const [record] = await db
      .insert(schema.conversationReads)
      .values({
        conversation_id: conversationId,
        user_id: userId,
        last_read_at: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.conversationReads.conversation_id, schema.conversationReads.user_id],
        set: { last_read_at: new Date(), updated_at: new Date() },
      })
      .returning();
    return record;
  }
}

export function createConversationRepository(): ConversationRepository {
  return new ConversationRepository();
}
