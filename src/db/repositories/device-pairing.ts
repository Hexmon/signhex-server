import { eq, and, desc, gt } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

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
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.devicePairings).values(data).returning();
    return result[0];
  }

  async findByCode(code: string) {
    const db = getDatabase();
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

  async findByDeviceId(deviceId: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.devicePairings)
      .where(eq(schema.devicePairings.device_id, deviceId))
      .orderBy(desc(schema.devicePairings.created_at));
    return result[0] || null;
  }

  async markAsUsed(id: string) {
    const db = getDatabase();
    const result = await db
      .update(schema.devicePairings)
      .set({ used: true, used_at: new Date() })
      .where(eq(schema.devicePairings.id, id))
      .returning();
    return result[0] || null;
  }

  async updateDeviceInfo(id: string, device_info: Record<string, any> | null) {
    const db = getDatabase();
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

    const total = await db.select().from(schema.devicePairings);

    const items = await db
      .select()
      .from(schema.devicePairings)
      .orderBy(desc(schema.devicePairings.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: total.length,
      page,
      limit,
    };
  }

  async findById(id: string) {
    const db = getDatabase();
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
