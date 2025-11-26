import { eq, and, like, desc, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class UserRepository {
  async create(data: {
    email: string;
    password_hash: string;
    first_name?: string;
    last_name?: string;
    role: 'ADMIN' | 'OPERATOR' | 'DEPARTMENT';
    department_id?: string;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.users).values(data).returning();
    return result[0];
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db.select().from(schema.users).where(eq(schema.users.id, id));
    return result[0] || null;
  }

  async findByInviteToken(token: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.users)
      .where(sql`(ext->>'invite_token') = ${token}`);
    return (result as any)[0] || null;
  }

  async findByEmail(email: string) {
    const db = getDatabase();
    const result = await db.select().from(schema.users).where(eq(schema.users.email, email));
    return result[0] || null;
  }

  async list(options: {
    page?: number;
    limit?: number;
    role?: string;
    department_id?: string;
    is_active?: boolean;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    let query = db.select().from(schema.users);

    const conditions = [];
    if (options.role) {
      conditions.push(eq(schema.users.role, options.role as any));
    }
    if (options.department_id) {
      conditions.push(eq(schema.users.department_id, options.department_id));
    }
    if (options.is_active !== undefined) {
      conditions.push(eq(schema.users.is_active, options.is_active));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db
      .select()
      .from(schema.users)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query.limit(limit).offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async update(id: string, data: Partial<typeof schema.users.$inferInsert>) {
    const db = getDatabase();
    const result = await db
      .update(schema.users)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.users.id, id))
      .returning();
    return result[0] || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.users).where(eq(schema.users.id, id));
  }
}

export function createUserRepository(): UserRepository {
  return new UserRepository();
}
