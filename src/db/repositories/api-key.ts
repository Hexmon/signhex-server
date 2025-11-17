import { and, desc, eq } from 'drizzle-orm';
import crypto from 'crypto';
import { getDatabase, schema } from '@/db';

export class ApiKeyRepository {
  private hashSecret(secret: string) {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }

  private generateSecret() {
    const raw = crypto.randomBytes(24).toString('base64url'); // ~32 chars
    const prefix = raw.substring(0, 12);
    return { raw, prefix };
  }

  async create(data: {
    name: string;
    scopes?: string[];
    roles?: string[];
    created_by: string;
    expires_at?: Date | null;
  }) {
    const db = getDatabase();
    const { raw, prefix } = this.generateSecret();
    const hash = this.hashSecret(raw);

    const [record] = await db
      .insert(schema.apiKeys)
      .values({
        name: data.name,
        scopes: data.scopes,
        roles: data.roles,
        created_by: data.created_by,
        expires_at: data.expires_at ?? null,
        token_prefix: prefix,
        secret_hash: hash,
      })
      .returning();

    return { record, secret: raw };
  }

  async list(options: { page?: number; limit?: number; includeRevoked?: boolean }) {
    const db = getDatabase();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    const includeRevoked = options.includeRevoked ?? false;
    const where = includeRevoked ? undefined : eq(schema.apiKeys.is_revoked, false);

    const items = await db
      .select()
      .from(schema.apiKeys)
      .where(where as any)
      .orderBy(desc(schema.apiKeys.created_at))
      .limit(limit)
      .offset(offset);

    const total = await db.select().from(schema.apiKeys).where(where as any);

    return { items, total: total.length, page, limit };
  }

  async findById(id: string) {
    const db = getDatabase();
    const [record] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    return record || null;
  }

  async revoke(id: string) {
    const db = getDatabase();
    const [record] = await db
      .update(schema.apiKeys)
      .set({ is_revoked: true, updated_at: new Date() })
      .where(eq(schema.apiKeys.id, id))
      .returning();
    return record || null;
  }

  async rotate(id: string) {
    const db = getDatabase();
    const { raw, prefix } = this.generateSecret();
    const hash = this.hashSecret(raw);
    const [record] = await db
      .update(schema.apiKeys)
      .set({
        token_prefix: prefix,
        secret_hash: hash,
        is_revoked: false,
        updated_at: new Date(),
      })
      .where(eq(schema.apiKeys.id, id))
      .returning();
    return { record: record || null, secret: raw };
  }

  async touchLastUsed(prefix: string) {
    const db = getDatabase();
    await db
      .update(schema.apiKeys)
      .set({ last_used_at: new Date() })
      .where(and(eq(schema.apiKeys.token_prefix, prefix), eq(schema.apiKeys.is_revoked, false)));
  }
}

export function createApiKeyRepository(): ApiKeyRepository {
  return new ApiKeyRepository();
}
