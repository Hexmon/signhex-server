import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class NotificationRepository {
  async create(data: {
    user_id: string;
    title: string;
    message: string;
    type: string;
    data?: Record<string, any>;
  }) {
    const db = getDatabase();
    return db.transaction(async (tx) => {
      const [created] = await tx.insert(schema.notifications).values(data).returning();

      await tx
        .insert(schema.userNotificationCounters)
        .values({
          user_id: data.user_id,
          unread_total: 1,
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.userNotificationCounters.user_id,
          set: {
            unread_total: sql`GREATEST(${schema.userNotificationCounters.unread_total} + 1, 0)`,
            updated_at: new Date(),
          },
        });

      return created;
    });
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, id));
    return result[0] || null;
  }

  async listByUser(userId: string, options: {
    page?: number;
    limit?: number;
    read?: boolean;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(schema.notifications.user_id, userId)];
    if (options.read !== undefined) {
      conditions.push(eq(schema.notifications.is_read, options.read));
    }

    const [totalRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(and(...conditions));

    const [unreadRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.user_id, userId),
          eq(schema.notifications.is_read, false)
        )
      );

    const items = await db
      .select()
      .from(schema.notifications)
      .where(and(...conditions))
      .orderBy(desc(schema.notifications.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: Number(totalRow?.count || 0),
      unread_total: Number(unreadRow?.count || 0),
      page,
      limit,
    };
  }

  async markAsRead(id: string) {
    const result = await this.markAsReadIfUnread(id);
    return result.notification;
  }

  async markAsReadIfUnread(id: string) {
    const db = getDatabase();
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.notifications)
        .set({ is_read: true })
        .where(
          and(
            eq(schema.notifications.id, id),
            eq(schema.notifications.is_read, false)
          )
        )
        .returning();

      if (updated) {
        return { notification: updated, changed: true };
      }

      const [existing] = await tx
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.id, id));
      return { notification: existing || null, changed: false };
    });
  }

  async markAllAsRead(userId: string) {
    const db = getDatabase();
    const rows = await db
      .update(schema.notifications)
      .set({ is_read: true })
      .where(and(
        eq(schema.notifications.user_id, userId),
        eq(schema.notifications.is_read, false)
      ))
      .returning({ id: schema.notifications.id });
    return rows.length;
  }

  async delete(id: string) {
    const db = getDatabase();
    const [deleted] = await db
      .delete(schema.notifications)
      .where(eq(schema.notifications.id, id))
      .returning();
    return deleted || null;
  }

  async deleteOlderThan(days: number) {
    const db = getDatabase();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    await db
      .delete(schema.notifications)
      .where(
        and(
          eq(schema.notifications.is_read, true),
          lt(schema.notifications.created_at, cutoffDate),
        )
      );
  }
}

export function createNotificationRepository(): NotificationRepository {
  return new NotificationRepository();
}
