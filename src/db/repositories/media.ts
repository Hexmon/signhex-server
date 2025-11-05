import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class MediaRepository {
  async create(data: {
    name: string;
    type: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
    created_by: string;
    source_object_id?: string;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.media).values(data).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db.select().from(schema.media).where(eq(schema.media.id, id));
    return result[0] || null;
  }

  async list(options: {
    page?: number;
    limit?: number;
    type?: string;
    status?: string;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.type) {
      conditions.push(eq(schema.media.type, options.type as any));
    }
    if (options.status) {
      conditions.push(eq(schema.media.status, options.status as any));
    }

    let query = db.select().from(schema.media);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db
      .select()
      .from(schema.media)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query
      .orderBy(desc(schema.media.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.media.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.media)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.media.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.media).where(eq(schema.media.id, id));
  }
}

export function createMediaRepository(): MediaRepository {
  return new MediaRepository();
}

