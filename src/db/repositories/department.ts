import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class DepartmentRepository {
  async create(data: {
    name: string;
    description?: string;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.departments).values(data).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.departments)
      .where(eq(schema.departments.id, id));
    return result[0] || null;
  }

  async list(options: {
    page?: number;
    limit?: number;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const total = await db.select().from(schema.departments);

    const items = await db
      .select()
      .from(schema.departments)
      .orderBy(desc(schema.departments.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.departments.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.departments)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.departments.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.departments).where(eq(schema.departments.id, id));
  }
}

export function createDepartmentRepository(): DepartmentRepository {
  return new DepartmentRepository();
}

