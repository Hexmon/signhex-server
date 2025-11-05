import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class RequestMessageRepository {
  async create(data: {
    request_id: string;
    user_id: string;
    message: string;
    attachments?: string[];
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.requestMessages).values({
      request_id: data.request_id,
      author_id: data.user_id,
      content: data.message,
    }).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.requestMessages)
      .where(eq(schema.requestMessages.id, id));
    return result[0] || null;
  }

  async listByRequest(requestId: string, options: {
    page?: number;
    limit?: number;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 50;
    const offset = (page - 1) * limit;

    const total = await db
      .select()
      .from(schema.requestMessages)
      .where(eq(schema.requestMessages.request_id, requestId));

    const items = await db
      .select()
      .from(schema.requestMessages)
      .where(eq(schema.requestMessages.request_id, requestId))
      .orderBy(desc(schema.requestMessages.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.requestMessages.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.requestMessages)
      .set(data)
      .where(eq(schema.requestMessages.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.requestMessages).where(eq(schema.requestMessages.id, id));
  }
}

export function createRequestMessageRepository(): RequestMessageRepository {
  return new RequestMessageRepository();
}

