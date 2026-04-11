import { eq, and, desc, or, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class ScreenGroupRepository {
  async create(data: { name: string; description?: string; screen_ids?: string[] }) {
    const db = getDatabase();
    const [group] = await db.insert(schema.screenGroups).values({ name: data.name, description: data.description }).returning();
    if (data.screen_ids && data.screen_ids.length) {
      await db
        .insert(schema.screenGroupMembers)
        .values(data.screen_ids.map((sid) => ({ group_id: group.id, screen_id: sid })));
    }
    return group;
  }

  async findById(id: string) {
    const db = getDatabase();
    const [group] = await db.select().from(schema.screenGroups).where(eq(schema.screenGroups.id, id));
    return group || null;
  }

  async list(options: { page?: number; limit?: number; q?: string }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.q?.trim()) {
      const term = `%${options.q.trim()}%`;
      conditions.push(
        or(
          sql`${schema.screenGroups.id}::text ILIKE ${term}`,
          sql`${schema.screenGroups.name} ILIKE ${term}`,
          sql`${schema.screenGroups.description} ILIKE ${term}`
        )
      );
    }

    let query = db.select().from(schema.screenGroups);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    const [total] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.screenGroups)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const items = await query
      .orderBy(desc(schema.screenGroups.created_at))
      .limit(limit)
      .offset(offset);

    return { items, total: Number(total?.count ?? 0), page, limit };
  }

  async members(groupId: string) {
    const db = getDatabase();
    return db.select().from(schema.screenGroupMembers).where(eq(schema.screenGroupMembers.group_id, groupId));
  }

  async update(
    id: string,
    data: { name?: string; description?: string; screen_ids?: string[] }
  ) {
    const db = getDatabase();
    const [group] = await db
      .update(schema.screenGroups)
      .set({ name: data.name, description: data.description, updated_at: new Date() })
      .where(eq(schema.screenGroups.id, id))
      .returning();
    if (!group) return null;

    if (data.screen_ids) {
      await db.delete(schema.screenGroupMembers).where(eq(schema.screenGroupMembers.group_id, id));
      if (data.screen_ids.length) {
        await db
          .insert(schema.screenGroupMembers)
          .values(data.screen_ids.map((sid) => ({ group_id: id, screen_id: sid })));
      }
    }
    return group;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.screenGroupMembers).where(eq(schema.screenGroupMembers.group_id, id));
    await db.delete(schema.screenGroups).where(eq(schema.screenGroups.id, id));
  }
}

export function createScreenGroupRepository(): ScreenGroupRepository {
  return new ScreenGroupRepository();
}
