import { eq, desc, and, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class RoleRepository {
  async create(data: {
    name: string;
    description?: string;
    permissions: any;
    is_system?: boolean;
  }) {
    const db = getDatabase();
    const [role] = await db
      .insert(schema.roles)
      .values({
        name: data.name,
        description: data.description,
        permissions: data.permissions,
        is_system: data.is_system ?? false,
      })
      .returning();
    return role;
  }

  async list(options: { page?: number; limit?: number; search?: string } = {}) {
    const db = getDatabase();
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.search) {
      conditions.push(sql`LOWER(${schema.roles.name}) LIKE ${'%' + options.search.toLowerCase() + '%'}`);
    }

    let query = db.select().from(schema.roles);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.roles)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query.orderBy(desc(schema.roles.created_at)).limit(limit).offset(offset);
    const total = totalRows.length > 0 ? Number((totalRows[0] as any).count) : 0;

    return { items, total, page, limit };
  }

  async findById(id: string) {
    const db = getDatabase();
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, id));
    return role || null;
  }

  async findByName(name: string) {
    const db = getDatabase();
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, name));
    return role || null;
  }

  async update(id: string, data: Partial<{ name: string; description?: string; permissions: any; is_system?: boolean }>) {
    const db = getDatabase();
    const [role] = await db
      .update(schema.roles)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.roles.id, id))
      .returning();
    return role || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.roles).where(eq(schema.roles.id, id));
  }
}

export function createRoleRepository(): RoleRepository {
  return new RoleRepository();
}
