import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class RequestRepository {
  async create(data: {
    title: string;
    description?: string;
    status?: 'OPEN' | 'IN_PROGRESS' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
    priority?: 'LOW' | 'MEDIUM' | 'HIGH';
    created_by: string;
    assigned_to?: string;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.requests).values({
      ...data,
      status: data.status || 'OPEN'
    }).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, id));
    return result[0] || null;
  }

  async list(options: {
    page?: number;
    limit?: number;
    status?: string;
    assigned_to?: string;
    created_by?: string;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.status) {
      conditions.push(eq(schema.requests.status, options.status as any));
    }
    if (options.assigned_to) {
      conditions.push(eq(schema.requests.assigned_to, options.assigned_to));
    }
    if (options.created_by) {
      conditions.push(eq(schema.requests.created_by, options.created_by));
    }

    let query = db.select().from(schema.requests);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db
      .select()
      .from(schema.requests)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query
      .orderBy(desc(schema.requests.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.requests.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.requests)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.requests.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.requests).where(eq(schema.requests.id, id));
  }
}

export function createRequestRepository(): RequestRepository {
  return new RequestRepository();
}

