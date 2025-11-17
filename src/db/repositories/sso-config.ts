import { and, eq } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class SsoConfigRepository {
  async upsertActive(data: {
    provider: string;
    issuer: string;
    client_id: string;
    client_secret: string;
    authorization_url?: string;
    token_url?: string;
    jwks_url?: string;
    redirect_uri?: string;
    scopes?: string[];
    is_active?: boolean;
  }) {
    const db = getDatabase();
    // Deactivate others if this one is active
    if (data.is_active !== false) {
      await db.update(schema.ssoConfigs).set({ is_active: false });
    }

    const [record] = await db
      .insert(schema.ssoConfigs)
      .values({
        ...data,
        is_active: data.is_active !== false,
      })
      .returning();

    return record;
  }

  async listActive() {
    const db = getDatabase();
    const result = await db.select().from(schema.ssoConfigs).where(eq(schema.ssoConfigs.is_active, true));
    return result;
  }

  async deactivate(id: string) {
    const db = getDatabase();
    const [record] = await db
      .update(schema.ssoConfigs)
      .set({ is_active: false, updated_at: new Date() })
      .where(eq(schema.ssoConfigs.id, id))
      .returning();
    return record || null;
  }
}

export function createSsoConfigRepository(): SsoConfigRepository {
  return new SsoConfigRepository();
}
