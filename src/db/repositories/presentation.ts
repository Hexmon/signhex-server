import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class PresentationRepository {
  async create(data: {
    name: string;
    description?: string;
    created_by: string;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.presentations).values(data).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.presentations)
      .where(eq(schema.presentations.id, id));
    return result[0] || null;
  }

  async list(options: {
    page?: number;
    limit?: number;
    created_by?: string;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.created_by) {
      conditions.push(eq(schema.presentations.created_by, options.created_by));
    }

    let query = db.select().from(schema.presentations);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db
      .select()
      .from(schema.presentations)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query
      .orderBy(desc(schema.presentations.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.presentations.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.presentations)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.presentations.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.presentations).where(eq(schema.presentations.id, id));
  }
}

export function createPresentationRepository(): PresentationRepository {
  return new PresentationRepository();
}

