import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

type ScheduleRequestStatus = (typeof schema.scheduleRequestStatusEnum.enumValues)[number];
type ScheduleRequestStatusFilter = ScheduleRequestStatus;
type ScheduleRequestDateField = 'created_at' | 'schedule_window';
type ScheduleRequestSortDirection = 'asc' | 'desc';

function escapeLikeQuery(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

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
    q?: string;
    date_field?: ScheduleRequestDateField;
    date_from?: Date;
    date_to?: Date;
    sort_direction?: ScheduleRequestSortDirection;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    if (options.requested_by_ids && options.requested_by_ids.length === 0) {
      return { items: [], total: 0, page, limit };
    }

    const conditions = this.buildConditions(options ?? {});
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const primaryOrder =
      options.date_field === 'schedule_window'
        ? sql`(
            SELECT ${schema.schedules.start_at}
            FROM ${schema.schedules}
            WHERE ${schema.schedules.id} = ${schema.scheduleRequests.schedule_id}
          )`
        : schema.scheduleRequests.created_at;
    const primaryDirection = options.sort_direction === 'asc' ? asc(primaryOrder as any) : desc(primaryOrder as any);
    const secondaryDirection = options.sort_direction === 'asc'
      ? asc(schema.scheduleRequests.created_at)
      : desc(schema.scheduleRequests.created_at);

    let query = db.select().from(schema.scheduleRequests);
    if (whereClause) {
      query = query.where(whereClause) as any;
    }

    const [totalRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.scheduleRequests)
      .where(whereClause);
    const items = await query.orderBy(primaryDirection, secondaryDirection).limit(limit).offset(offset);

    return { items, total: Number(totalRow?.count || 0), page, limit };
  }

  async countSummary(options?: {
    requested_by?: string;
    requested_by_ids?: string[];
    q?: string;
    date_field?: ScheduleRequestDateField;
    date_from?: Date;
    date_to?: Date;
  }) {
    const db = getDatabase();
    if (options?.requested_by_ids && options.requested_by_ids.length === 0) {
      return { pending: 0, approved: 0, rejected: 0, published: 0, taken_down: 0, expired: 0 };
    }
    const conditions = this.buildConditions(options ?? {});
    const rows = await db
      .select({
        status: schema.scheduleRequests.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.scheduleRequests)
      .where(conditions.length ? and(...conditions) : undefined)
      .groupBy(schema.scheduleRequests.status);
    const counts = new Map(rows.map((row) => [row.status, Number(row.count || 0)]));

    return {
      pending: counts.get('PENDING') ?? 0,
      approved: counts.get('APPROVED') ?? 0,
      rejected: counts.get('REJECTED') ?? 0,
      published: counts.get('PUBLISHED') ?? 0,
      taken_down: counts.get('TAKEN_DOWN') ?? 0,
      expired: counts.get('EXPIRED') ?? 0,
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

  private buildConditions(options: {
    status?: ScheduleRequestStatusFilter;
    requested_by?: string;
    requested_by_ids?: string[];
    q?: string;
    date_field?: ScheduleRequestDateField;
    date_from?: Date;
    date_to?: Date;
  }) {
    const conditions: any[] = [];

    if (options.status) {
      conditions.push(eq(schema.scheduleRequests.status, options.status as ScheduleRequestStatus));
    }
    if (options.requested_by) {
      conditions.push(eq(schema.scheduleRequests.requested_by, options.requested_by));
    }
    if (options.requested_by_ids) {
      conditions.push(inArray(schema.scheduleRequests.requested_by, options.requested_by_ids as any));
    }

    const query = options.q?.trim();
    if (query) {
      const likePattern = `%${escapeLikeQuery(query)}%`;
      conditions.push(sql`(
        CAST(${schema.scheduleRequests.id} AS text) ILIKE ${likePattern} ESCAPE '\\'
        OR COALESCE(${schema.scheduleRequests.notes}, '') ILIKE ${likePattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM ${schema.schedules}
          WHERE ${schema.schedules.id} = ${schema.scheduleRequests.schedule_id}
            AND (
              COALESCE(${schema.schedules.name}, '') ILIKE ${likePattern} ESCAPE '\\'
              OR COALESCE(${schema.schedules.description}, '') ILIKE ${likePattern} ESCAPE '\\'
            )
        )
        OR EXISTS (
          SELECT 1
          FROM ${schema.users}
          LEFT JOIN ${schema.departments}
            ON ${schema.departments.id} = ${schema.users.department_id}
          WHERE ${schema.users.id} = ${schema.scheduleRequests.requested_by}
            AND (
              COALESCE(${schema.users.email}, '') ILIKE ${likePattern} ESCAPE '\\'
              OR COALESCE(${schema.users.first_name}, '') ILIKE ${likePattern} ESCAPE '\\'
              OR COALESCE(${schema.users.last_name}, '') ILIKE ${likePattern} ESCAPE '\\'
              OR COALESCE(CONCAT_WS(' ', ${schema.users.first_name}, ${schema.users.last_name}), '') ILIKE ${likePattern} ESCAPE '\\'
              OR COALESCE(${schema.departments.name}, '') ILIKE ${likePattern} ESCAPE '\\'
            )
        )
      )`);
    }

    if (options.date_field === 'schedule_window') {
      if (options.date_from || options.date_to) {
        const overlapConditions = [
          sql`${schema.schedules.id} = ${schema.scheduleRequests.schedule_id}`,
        ];
        if (options.date_from) {
          overlapConditions.push(gte(schema.schedules.end_at, options.date_from));
        }
        if (options.date_to) {
          overlapConditions.push(lte(schema.schedules.start_at, options.date_to));
        }
        conditions.push(sql`EXISTS (
          SELECT 1
          FROM ${schema.schedules}
          WHERE ${and(...overlapConditions)}
        )`);
      }
    } else {
      if (options.date_from) {
        conditions.push(gte(schema.scheduleRequests.created_at, options.date_from));
      }
      if (options.date_to) {
        conditions.push(lte(schema.scheduleRequests.created_at, options.date_to));
      }
    }

    return conditions;
  }
}

export function createScheduleRequestRepository(): ScheduleRequestRepository {
  return new ScheduleRequestRepository();
}
