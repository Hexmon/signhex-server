import { eq, and, sql, desc, or, getTableColumns } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class UserRepository {
  private async countRows(
    tableSql: string,
    columnSql: string,
    value: string
  ): Promise<number> {
    const db = getDatabase();
    const result = await db.execute(
      sql`SELECT count(*)::int AS count FROM ${sql.raw(tableSql)} WHERE ${sql.raw(columnSql)} = ${value}`
    );

    return Number((result as { rows?: Array<{ count?: number | string }> }).rows?.[0]?.count ?? 0);
  }

  async create(data: {
    email: string;
    password_hash: string;
    first_name?: string;
    last_name?: string;
    role_id: string;
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
    const normalizedToken = token.trim().toLowerCase();
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.users)
      .where(sql`LOWER(ext->>'invite_token') = ${normalizedToken}`);
    return (result as any)[0] || null;
  }

  async listInvites(options: {
    page?: number;
    limit?: number;
    statuses?: ('pending' | 'expired' | 'activated')[];
    invited_before?: Date;
    invited_after?: Date;
    email?: string;
    role_id?: string;
    department_id?: string;
  }) {
    const db = getDatabase();
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    const offset = (page - 1) * limit;
    const nowIso = new Date().toISOString();

    const conditions: any[] = [];

    // Only users that have invite metadata
    conditions.push(
      sql`${schema.users.ext} IS NOT NULL AND (${schema.users.ext} ? 'invite_token' OR ${schema.users.ext} ? 'invite_status' OR ${schema.users.ext} ? 'invite_expires_at' OR ${schema.users.ext} ? 'invited_at')`
    );

    if (options.email) {
      conditions.push(sql`LOWER(${schema.users.email}) LIKE ${'%' + options.email.toLowerCase() + '%'}`);
    }
    if (options.role_id) {
      conditions.push(eq(schema.users.role_id, options.role_id));
    }
    if (options.department_id) {
      conditions.push(eq(schema.users.department_id, options.department_id));
    }
    const invitedAtExpr = sql`COALESCE((${schema.users.ext}->>'invited_at')::timestamptz, ${schema.users.created_at})`;
    if (options.invited_before) {
      conditions.push(sql`${invitedAtExpr} <= ${options.invited_before}`);
    }
    if (options.invited_after) {
      conditions.push(sql`${invitedAtExpr} >= ${options.invited_after}`);
    }

    if (options.statuses && options.statuses.length > 0) {
      const statusConds = options.statuses.map((status) => {
        switch (status) {
          case 'pending':
            return sql`(ext->>'invite_token') IS NOT NULL AND (ext->>'invite_expires_at')::timestamptz > ${nowIso}`;
          case 'expired':
            return sql`(ext->>'invite_token') IS NOT NULL AND (ext->>'invite_expires_at')::timestamptz <= ${nowIso}`;
          case 'activated':
            return sql`COALESCE(ext->>'invite_status', '') = 'ACTIVATED'`;
          default:
            return null;
        }
      }).filter(Boolean) as any[];

      if (statusConds.length > 0) {
        conditions.push(or(...statusConds));
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await db
      .select({
        ...getTableColumns(schema.users),
        role: schema.roles.name,
      })
      .from(schema.users)
      .leftJoin(schema.roles, eq(schema.users.role_id, schema.roles.id))
      .where(whereClause)
      .orderBy(desc(schema.users.created_at))
      .limit(limit)
      .offset(offset);

    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.users)
      .where(whereClause);

    const total = totalRows.length > 0 ? Number((totalRows[0] as any).count) : 0;

    return {
      items,
      total,
      page,
      limit,
    };
  }

  async listPendingInvites() {
    const result = await this.listInvites({ statuses: ['pending'], page: 1, limit: 1000 });
    return result.items;
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
    role_id?: string;
    department_id?: string;
    is_active?: boolean;
  }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const conditions = [];
    if (options.role?.trim()) {
      conditions.push(sql`LOWER(${schema.roles.name}) = ${options.role.trim().toLowerCase()}`);
    }
    if (options.role_id) {
      conditions.push(eq(schema.users.role_id, options.role_id as any));
    }
    if (options.department_id) {
      conditions.push(eq(schema.users.department_id, options.department_id));
    }
    if (options.is_active !== undefined) {
      conditions.push(eq(schema.users.is_active, options.is_active));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await db
      .select({
        ...getTableColumns(schema.users),
        role: schema.roles.name,
      })
      .from(schema.users)
      .leftJoin(schema.roles, eq(schema.users.role_id, schema.roles.id))
      .where(whereClause)
      .orderBy(desc(schema.users.created_at))
      .limit(limit)
      .offset(offset);

    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.users)
      .leftJoin(schema.roles, eq(schema.users.role_id, schema.roles.id))
      .where(whereClause);

    return {
      items,
      total: totalRows.length > 0 ? Number((totalRows[0] as any).count) : 0,
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

  async getDeleteUsageSummary(id: string) {
    const db = getDatabase();
    const referencesResult = await db.execute(sql.raw(`
      SELECT DISTINCT
        nsp.nspname AS schema_name,
        rel.relname AS table_name,
        att.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      JOIN unnest(con.conkey) AS cols(attnum) ON TRUE
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = cols.attnum
      WHERE con.contype = 'f'
        AND con.confrelid = 'users'::regclass
        AND con.confdeltype <> 'c'
        AND nsp.nspname = current_schema()
    `));

    const labels: Record<string, string> = {
      chat_bookmarks: 'chat bookmarks',
      chat_conversations: 'chat conversations',
      chat_members: 'chat memberships',
      chat_message_revisions: 'chat message revisions',
      chat_messages: 'chat messages',
      chat_moderation: 'chat moderation records',
      chat_pins: 'chat pins',
      chat_reactions: 'chat reactions',
      chat_receipts: 'chat read receipts',
    };

    const references = (referencesResult as {
      rows?: Array<{ schema_name?: string; table_name?: string; column_name?: string }>;
    }).rows ?? [];

    const resolved = await Promise.all(
      references.map(async (reference) => {
        if (!reference.schema_name || !reference.table_name || !reference.column_name) {
          return null;
        }

        const count = await this.countRows(
          `"${reference.schema_name.replace(/"/g, '""')}"."${reference.table_name.replace(/"/g, '""')}"`,
          `"${reference.column_name.replace(/"/g, '""')}"`,
          id
        );

        if (count <= 0) {
          return null;
        }

        return {
          key: reference.table_name,
          label: labels[reference.table_name] ?? reference.table_name.replace(/_/g, ' '),
          count,
        };
      })
    );

    const matchedReferences = resolved.filter(
      (reference): reference is { key: string; label: string; count: number } => reference !== null
    );

    return {
      inUse: matchedReferences.length > 0,
      primaryReason: matchedReferences[0]?.key ?? null,
      references: matchedReferences,
    };
  }
}

export function createUserRepository(): UserRepository {
  return new UserRepository();
}
