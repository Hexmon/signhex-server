import { eq, and, asc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class ScheduleItemRepository {
  async listBySchedule(scheduleId: string) {
    const db = getDatabase();
    return db
      .select()
      .from(schema.scheduleItems)
      .where(eq(schema.scheduleItems.schedule_id, scheduleId))
      .orderBy(asc(schema.scheduleItems.start_at));
  }

  async create(data: {
    schedule_id: string;
    presentation_id: string;
    start_at: Date;
    end_at: Date;
    priority?: number;
    screen_ids?: string[];
    screen_group_ids?: string[];
  }) {
    const db = getDatabase();
    const [item] = await db
      .insert(schema.scheduleItems)
      .values({
        ...data,
        screen_ids: data.screen_ids ?? [],
        screen_group_ids: data.screen_group_ids ?? [],
      })
      .returning();
    return item;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.scheduleItems).where(eq(schema.scheduleItems.id, id));
  }
}

export function createScheduleItemRepository(): ScheduleItemRepository {
  return new ScheduleItemRepository();
}
