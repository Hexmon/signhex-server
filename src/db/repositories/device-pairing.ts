import { eq, and, desc, gt, lte, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

type DbExecutor = any;

function resolveDb(executor?: DbExecutor) {
  return executor ?? getDatabase();
}

export class DevicePairingRepository {
  async create(data: {
    device_id?: string | null;
    pairing_code: string;
    expires_at: Date;
    width?: number | null;
    height?: number | null;
    aspect_ratio?: string | null;
    orientation?: string | null;
    model?: string | null;
    codecs?: string[] | null;
    device_info?: Record<string, any> | null;
  }, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db.insert(schema.devicePairings).values(data).returning();
    return result[0];
  }

  async findByCode(code: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.devicePairings)
      .where(
        and(
          eq(schema.devicePairings.pairing_code, code),
          eq(schema.devicePairings.used, false),
          gt(schema.devicePairings.expires_at, new Date())
        )
      );
    return result[0] || null;
  }

  async findActiveById(id: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.devicePairings)
      .where(
        and(
          eq(schema.devicePairings.id, id),
          eq(schema.devicePairings.used, false),
          gt(schema.devicePairings.expires_at, new Date())
        )
      )
      .limit(1);
    return result[0] || null;
  }

  async findAnyByCode(code: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.pairing_code, code))
      .orderBy(desc(schema.devicePairings.created_at))
      .limit(1);
    return result[0] || null;
  }

  async findByDeviceId(deviceId: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.device_id, deviceId))
      .orderBy(desc(schema.devicePairings.created_at));
    return result[0] || null;
  }

  async findActiveByDeviceId(deviceId: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.devicePairings)
      .where(
        and(
          eq(schema.devicePairings.device_id, deviceId),
          eq(schema.devicePairings.used, false),
          gt(schema.devicePairings.expires_at, new Date())
        )
      )
      .orderBy(desc(schema.devicePairings.created_at));
    return result[0] || null;
  }

  async markAsUsed(id: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .update(schema.devicePairings)
      .set({ used: true, used_at: new Date() })
      .where(eq(schema.devicePairings.id, id))
      .returning();
    return result[0] || null;
  }

  async markAsUsedIfActive(id: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const now = new Date();
    const result = await db
      .update(schema.devicePairings)
      .set({ used: true, used_at: now })
      .where(
        and(
          eq(schema.devicePairings.id, id),
          eq(schema.devicePairings.used, false),
          gt(schema.devicePairings.expires_at, now)
        )
      )
      .returning();
    return result[0] || null;
  }

  async retireExpired(executor?: DbExecutor) {
    const db = resolveDb(executor);
    const now = new Date();
    return await db
      .update(schema.devicePairings)
      .set({
        used: true,
        used_at: now,
      })
      .where(
        and(
          eq(schema.devicePairings.used, false),
          lte(schema.devicePairings.expires_at, now)
        )
      )
      .returning();
  }

  async retireActiveByDeviceId(deviceId: string, exceptId?: string | null, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const activePairings = await db
      .select({ id: schema.devicePairings.id })
      .from(schema.devicePairings)
      .where(
        and(
          eq(schema.devicePairings.device_id, deviceId),
          eq(schema.devicePairings.used, false),
          gt(schema.devicePairings.expires_at, new Date())
        )
      );

    const retireIds = activePairings
      .map((row: { id: string }) => row.id)
      .filter((id: string) => !exceptId || id !== exceptId);

    if (retireIds.length === 0) {
      return [];
    }

    const retired: typeof schema.devicePairings.$inferSelect[] = [];
    const usedAt = new Date();
    for (const id of retireIds) {
      const [row] = await db
        .update(schema.devicePairings)
        .set({ used: true, used_at: usedAt })
        .where(eq(schema.devicePairings.id, id))
        .returning();
      if (row) {
        retired.push(row);
      }
    }

    return retired;
  }

  async updateDeviceInfo(id: string, device_info: Record<string, any> | null, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .update(schema.devicePairings)
      .set({ device_info })
      .where(eq(schema.devicePairings.id, id))
      .returning();
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

    const [total] = await db.select({ count: sql<number>`count(*)` }).from(schema.devicePairings);

    const items = await db
      .select()
      .from(schema.devicePairings)
      .orderBy(desc(schema.devicePairings.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: Number(total?.count ?? 0),
      page,
      limit,
    };
  }

  async findById(id: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.id, id));
    return result[0] || null;
  }
}

export function createDevicePairingRepository(): DevicePairingRepository {
  return new DevicePairingRepository();
}
