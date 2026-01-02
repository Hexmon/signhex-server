import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class LayoutRepository {
  async create(data: {
    name: string;
    description?: string;
    aspect_ratio: string;
    spec: Record<string, any>;
  }) {
    const db = getDatabase();
    const [layout] = await db.insert(schema.layouts).values(data).returning();
    return layout;
  }

  async findById(id: string) {
    const db = getDatabase();
    const [layout] = await db.select().from(schema.layouts).where(eq(schema.layouts.id, id));
    return layout || null;
  }

  async list(options: { page?: number; limit?: number; aspect_ratio?: string }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.aspect_ratio) {
      conditions.push(eq(schema.layouts.aspect_ratio, options.aspect_ratio));
    }

    let query = db.select().from(schema.layouts);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db.select().from(schema.layouts).where(conditions.length ? and(...conditions) : undefined);

    const items = await query.orderBy(desc(schema.layouts.created_at)).limit(limit).offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.layouts.$inferInsert>) {
    const db = getDatabase();
    const [layout] = await db
      .update(schema.layouts)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.layouts.id, id))
      .returning();
    return layout || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.layouts).where(eq(schema.layouts.id, id));
  }
}

export function createLayoutRepository(): LayoutRepository {
  return new LayoutRepository();
}
