import { eq, and, desc, or, sql } from 'drizzle-orm';
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

  async list(options: { page?: number; limit?: number; aspect_ratio?: string; search?: string }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.search?.trim()) {
      const searchTerm = `%${options.search.trim()}%`;
      conditions.push(
        or(
          sql`${schema.layouts.name} ILIKE ${searchTerm}`,
          sql`${schema.layouts.description} ILIKE ${searchTerm}`,
          sql`${schema.layouts.spec}::text ILIKE ${searchTerm}`
        )
      );
    }
    if (options.aspect_ratio) {
      conditions.push(eq(schema.layouts.aspect_ratio, options.aspect_ratio));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    let query = db.select().from(schema.layouts);
    if (whereClause) {
      query = query.where(whereClause) as any;
    }

    let totalQuery = db.select().from(schema.layouts);
    if (whereClause) {
      totalQuery = totalQuery.where(whereClause) as any;
    }
    const total = await totalQuery;

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
