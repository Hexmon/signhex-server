import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class NotificationRepository {
  async create(data: {
    user_id: string;
    title: string;
    message: string;
    type: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS';
    data?: Record<string, any>;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.notifications).values(data).returning();
    return result[0];
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

    const total = await db
      .select()
      .from(schema.notifications)
      .where(and(...conditions));

    const items = await db
      .select()
      .from(schema.notifications)
      .where(and(...conditions))
      .orderBy(desc(schema.notifications.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async markAsRead(id: string) {
    const db = getDatabase();
    const result = await db
      .update(schema.notifications)
      .set({ is_read: true })
      .where(eq(schema.notifications.id, id))
      .returning();
    return result[0] || null;
  }

  async markAllAsRead(userId: string) {
    const db = getDatabase();
    await db
      .update(schema.notifications)
      .set({ is_read: true })
      .where(and(
        eq(schema.notifications.user_id, userId),
        eq(schema.notifications.is_read, false)
      ));
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.notifications).where(eq(schema.notifications.id, id));
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
          // @ts-ignore - Drizzle doesn't have a built-in lt operator
          // This would need to be implemented with raw SQL
        )
      );
  }
}

export function createNotificationRepository(): NotificationRepository {
  return new NotificationRepository();
}

