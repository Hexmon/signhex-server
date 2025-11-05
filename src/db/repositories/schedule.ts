import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class ScheduleRepository {
  async create(data: {
    name: string;
    description?: string;
    created_by: string;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.schedules).values(data).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db.select().from(schema.schedules).where(eq(schema.schedules.id, id));
    return result[0] || null;
  }

  async list(options: {
    page?: number;
    limit?: number;
    is_active?: boolean;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.is_active !== undefined) {
      conditions.push(eq(schema.schedules.is_active, options.is_active));
    }

    let query = db.select().from(schema.schedules);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db
      .select()
      .from(schema.schedules)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query
      .orderBy(desc(schema.schedules.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.schedules.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.schedules)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.schedules.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.schedules).where(eq(schema.schedules.id, id));
  }
}

export function createScheduleRepository(): ScheduleRepository {
  return new ScheduleRepository();
}

