import { eq, desc, sql } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

type DbExecutor = any;

function resolveDb(executor?: DbExecutor) {
  return executor ?? getDatabase();
}

export class DeviceCertificateRepository {
  async create(data: {
    device_id: string;
    certificate: string;
    private_key: string;
    serial: string;
    expires_at: Date;
    public_key_pem?: string | null;
    auth_version?: string | null;
  }, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db.insert(schema.deviceCertificates).values({
      screen_id: data.device_id,
      serial: data.serial,
      certificate_pem: data.certificate,
      public_key_pem: data.public_key_pem ?? null,
      auth_version: data.auth_version ?? 'legacy',
      expires_at: data.expires_at,
    }).returning();
    return result[0];
  }

  async findByDeviceId(deviceId: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.screen_id, deviceId));
    return result[0] || null;
  }

  async listByDeviceId(deviceId: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    return await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.screen_id, deviceId))
      .orderBy(desc(schema.deviceCertificates.created_at));
  }

  async findLatestByDeviceId(deviceId: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.screen_id, deviceId))
      .orderBy(desc(schema.deviceCertificates.created_at))
      .limit(1);
    return result[0] || null;
  }

  async findByFingerprint(fingerprint: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.serial, fingerprint));
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

    const total = await db.select({ count: sql<number>`count(*)` }).from(schema.deviceCertificates);

    const items = await db
      .select()
      .from(schema.deviceCertificates)
      .orderBy(desc(schema.deviceCertificates.created_at))
      .limit(limit)
      .offset(offset);

    return {
      items,
      total: Number(total[0]?.count ?? 0),
      page,
      limit,
    };
  }

  async revoke(id: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .update(schema.deviceCertificates)
      .set({ is_revoked: true, revoked_at: new Date() })
      .where(eq(schema.deviceCertificates.id, id))
      .returning();
    return result[0] || null;
  }

  async revokeByDeviceId(deviceId: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    return await db
      .update(schema.deviceCertificates)
      .set({ is_revoked: true, revoked_at: new Date() })
      .where(eq(schema.deviceCertificates.screen_id, deviceId))
      .returning();
  }

  async findById(id: string, executor?: DbExecutor) {
    const db = resolveDb(executor);
    const result = await db
      .select()
      .from(schema.deviceCertificates)
      .where(eq(schema.deviceCertificates.id, id));
    return result[0] || null;
  }
}

export function createDeviceCertificateRepository(): DeviceCertificateRepository {
  return new DeviceCertificateRepository();
}
