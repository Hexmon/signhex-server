import { eq, and, desc, asc, or, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class ScreenRepository {
  async create(data: {
    id?: string;
    name: string;
    location?: string;
    aspect_ratio?: string | null;
    width?: number | null;
    height?: number | null;
    orientation?: string | null;
    device_info?: Record<string, any> | null;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.screens).values(data).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db.select().from(schema.screens).where(eq(schema.screens.id, id));
    return result[0] || null;
  }

  async list(options: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.status) {
      conditions.push(eq(schema.screens.status, options.status as any));
    }

    let query = db.select().from(schema.screens);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db
      .select()
      .from(schema.screens)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query
      .orderBy(desc(schema.screens.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async listAspectRatios(options?: { search?: string }) {
    const db = getDatabase();
    const conditions = [];
    if (options?.search?.trim()) {
      const term = `%${options.search.trim()}%`;
      conditions.push(
        or(
          sql`${schema.screens.name} ILIKE ${term}`,
          sql`${schema.screens.aspect_ratio} ILIKE ${term}`
        )
      );
    }

    let query = db
      .select({
        id: schema.screens.id,
        name: schema.screens.name,
        aspect_ratio: schema.screens.aspect_ratio,
      })
      .from(schema.screens);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    return query.orderBy(asc(schema.screens.name));
  }

  async update(id: string, data: Partial<typeof schema.screens.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.screens)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.screens.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.screens).where(eq(schema.screens.id, id));
  }
}

export function createScreenRepository(): ScreenRepository {
  return new ScreenRepository();
}
