import { eq, and, desc } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

type ScheduleRequestStatus = (typeof schema.scheduleRequestStatusEnum.enumValues)[number];

export class ScheduleRequestRepository {
  async create(data: {
    schedule_id: string;
    notes?: string;
    requested_by: string;
    payload?: any;
  }) {
    const db = getDatabase();
    const [req] = await db
      .insert(schema.scheduleRequests)
      .values({
        schedule_id: data.schedule_id,
        schedule_payload: data.payload ?? {},
        notes: data.notes,
        requested_by: data.requested_by,
      })
      .returning();
    return req;
  }

  async findById(id: string) {
    const db = getDatabase();
    const [req] = await db.select().from(schema.scheduleRequests).where(eq(schema.scheduleRequests.id, id));
    return req || null;
  }

  async list(options: { page?: number; limit?: number; status?: ScheduleRequestStatus; requested_by?: string }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.status) conditions.push(eq(schema.scheduleRequests.status, options.status));
    if (options.requested_by) conditions.push(eq(schema.scheduleRequests.requested_by, options.requested_by));

    let query = db.select().from(schema.scheduleRequests);
    if (conditions.length) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db.select().from(schema.scheduleRequests).where(conditions.length ? and(...conditions) : undefined);
    const items = await query.orderBy(desc(schema.scheduleRequests.created_at)).limit(limit).offset(offset);

    return { items, total: total.length, page, limit };
  }

  async updateStatus(id: string, status: ScheduleRequestStatus, reviewed_by: string, review_notes?: string) {
    const db = getDatabase();
    const [req] = await db
      .update(schema.scheduleRequests)
      .set({ status, reviewed_by, reviewed_at: new Date(), review_notes, updated_at: new Date() })
      .where(eq(schema.scheduleRequests.id, id))
      .returning();
    return req || null;
  }
}

export function createScheduleRequestRepository(): ScheduleRequestRepository {
  return new ScheduleRequestRepository();
}
