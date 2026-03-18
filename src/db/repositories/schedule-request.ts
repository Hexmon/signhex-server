import { eq, and, desc, lt, sql, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

type ScheduleRequestStatus = (typeof schema.scheduleRequestStatusEnum.enumValues)[number];
type ScheduleRequestStatusFilter = ScheduleRequestStatus | 'EXPIRED' | 'PUBLISHED';

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

  async list(options: {
    page?: number;
    limit?: number;
    status?: ScheduleRequestStatusFilter;
    requested_by?: string;
    requested_by_ids?: string[];
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    if (options.requested_by_ids && options.requested_by_ids.length === 0) {
      return { items: [], total: 0, page, limit };
    }

    const isExpiredFilter = options.status === 'EXPIRED';
    const isPublishedFilter = options.status === 'PUBLISHED';

    if (isExpiredFilter) {
      const now = new Date();
      const expiredConditions = [
        lt(schema.schedules.end_at, now),
        ...(options.requested_by ? [eq(schema.scheduleRequests.requested_by, options.requested_by)] : []),
        ...(options.requested_by_ids ? [inArray(schema.scheduleRequests.requested_by, options.requested_by_ids as any)] : []),
      ];

      const buildExpiredQuery = () =>
        db
          .select({ request: schema.scheduleRequests })
          .from(schema.scheduleRequests)
          .innerJoin(schema.schedules, eq(schema.scheduleRequests.schedule_id, schema.schedules.id));

      const whereClause = and(...expiredConditions);

      const totalRows = await buildExpiredQuery().where(whereClause);
      const itemsWithRequest = await buildExpiredQuery()
        .where(whereClause)
        .orderBy(desc(schema.scheduleRequests.created_at))
        .limit(limit)
        .offset(offset);

      const items = itemsWithRequest.map((row) => row.request);
      return { items, total: totalRows.length, page, limit };
    }

    if (isPublishedFilter) {
      const publishedConditions = [
        sql`${schema.scheduleRequests.schedule_id} IN (SELECT ${schema.publishes.schedule_id} FROM ${schema.publishes})`,
        ...(options.requested_by ? [eq(schema.scheduleRequests.requested_by, options.requested_by)] : []),
        ...(options.requested_by_ids ? [inArray(schema.scheduleRequests.requested_by, options.requested_by_ids as any)] : []),
      ];

      const whereClause = and(...publishedConditions);

      const total = await db
        .select()
        .from(schema.scheduleRequests)
        .where(whereClause);
      const items = await db
        .select()
        .from(schema.scheduleRequests)
        .where(whereClause)
        .orderBy(desc(schema.scheduleRequests.created_at))
        .limit(limit)
        .offset(offset);

      return { items, total: total.length, page, limit };
    }

    const conditions = [];
    if (options.status) conditions.push(eq(schema.scheduleRequests.status, options.status as ScheduleRequestStatus));
    if (options.requested_by) conditions.push(eq(schema.scheduleRequests.requested_by, options.requested_by));
    if (options.requested_by_ids) conditions.push(inArray(schema.scheduleRequests.requested_by, options.requested_by_ids as any));

    let query = db.select().from(schema.scheduleRequests);
    if (conditions.length) {
      query = query.where(and(...conditions)) as any;
    }

    const total = await db.select().from(schema.scheduleRequests).where(conditions.length ? and(...conditions) : undefined);
    const items = await query.orderBy(desc(schema.scheduleRequests.created_at)).limit(limit).offset(offset);

    return { items, total: total.length, page, limit };
  }

  async countSummary(options?: { requested_by?: string; requested_by_ids?: string[] }) {
    const db = getDatabase();
    if (options?.requested_by_ids && options.requested_by_ids.length === 0) {
      return { pending: 0, approved: 0, rejected: 0, published: 0, expired: 0 };
    }
    const baseConditions = options?.requested_by
      ? [eq(schema.scheduleRequests.requested_by, options.requested_by)]
      : [];
    if (options?.requested_by_ids) {
      baseConditions.push(inArray(schema.scheduleRequests.requested_by, options.requested_by_ids as any));
    }
    const combine = (...extra: any[]) => {
      const filters = [...baseConditions, ...extra].filter(Boolean);
      if (filters.length === 0) return undefined;
      if (filters.length === 1) return filters[0];
      return and(...filters);
    };

    const count = async (whereClause: any) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.scheduleRequests)
        .where(whereClause);
      return Number(row?.count || 0);
    };

    const pending = await count(combine(eq(schema.scheduleRequests.status, 'PENDING')));
    const approved = await count(combine(eq(schema.scheduleRequests.status, 'APPROVED')));
    const rejected = await count(combine(eq(schema.scheduleRequests.status, 'REJECTED')));

    const now = new Date();
    const expiredClause = combine(lt(schema.schedules.end_at, now));
    const [expiredRow] = await db
      .select({ count: sql<number>`count(distinct ${schema.scheduleRequests.id})` })
      .from(schema.scheduleRequests)
      .innerJoin(schema.schedules, eq(schema.scheduleRequests.schedule_id, schema.schedules.id))
      .where(expiredClause);
    const expired = Number(expiredRow?.count || 0);

    const publishedClause = combine();
    const [publishedRow] = await db
      .select({ count: sql<number>`count(distinct ${schema.scheduleRequests.id})` })
      .from(schema.scheduleRequests)
      .innerJoin(schema.publishes, eq(schema.scheduleRequests.schedule_id, schema.publishes.schedule_id))
      .where(publishedClause);
    const published = Number(publishedRow?.count || 0);

    return {
      pending,
      approved,
      rejected,
      published,
      expired,
    };
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
