import { eq, desc, isNull, and } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class EmergencyRepository {
  async create(data: {
    triggered_by: string;
    message: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    emergency_type_id?: string | null;
    media_id?: string | null;
    screen_ids?: string[] | null;
    screen_group_ids?: string[] | null;
    target_all?: boolean;
  }) {
    const db = getDatabase();
    const result = await db
      .insert(schema.emergencies)
      .values({
        triggered_by: data.triggered_by,
        message: data.message,
        priority: data.severity,
        emergency_type_id: data.emergency_type_id ?? null,
        media_id: data.media_id ?? null,
        screen_ids: data.screen_ids ?? [],
        screen_group_ids: data.screen_group_ids ?? [],
        target_all: data.target_all ?? false,
        is_active: true,
      })
      .returning();
    return result[0];
  }

  async getActive() {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.emergencies)
      .where(and(isNull(schema.emergencies.cleared_at), eq(schema.emergencies.is_active, true)))
      .orderBy(desc(schema.emergencies.created_at));
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

    const total = await db.select().from(schema.emergencies);

    const items = await db
      .select()
      .from(schema.emergencies)
      .orderBy(desc(schema.emergencies.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async clear(id: string, cleared_by: string) {
    const db = getDatabase();
    const result = await db
      .update(schema.emergencies)
      .set({
        cleared_at: new Date(),
        cleared_by,
        is_active: false,
      })
      .where(eq(schema.emergencies.id, id))
      .returning();
    return result[0] || null;
  }

  async findById(id: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.emergencies)
      .where(eq(schema.emergencies.id, id));
    return result[0] || null;
  }
}

export function createEmergencyRepository(): EmergencyRepository {
  return new EmergencyRepository();
}
