import { eq, desc } from 'drizzle-orm';
import crypto from 'crypto';
import { getDatabase, schema } from '@/db';

export class WebhookRepository {
  private generateSecret() {
    return crypto.randomBytes(16).toString('hex');
  }

  async create(data: {
    name: string;
    event_types: string[];
    target_url: string;
    headers?: Record<string, string>;
    is_active?: boolean;
    created_by: string;
  }) {
    const db = getDatabase();
    const secret = this.generateSecret();
    const [record] = await db
      .insert(schema.webhookSubscriptions)
      .values({
        name: data.name,
        event_types: data.event_types,
        target_url: data.target_url,
        headers: data.headers,
        is_active: data.is_active ?? true,
        secret,
        created_by: data.created_by,
      })
      .returning();
    return { record, secret };
  }

  async list() {
    const db = getDatabase();
    const items = await db.select().from(schema.webhookSubscriptions).orderBy(desc(schema.webhookSubscriptions.created_at));
    return items;
  }

  async findById(id: string) {
    const db = getDatabase();
    const [record] = await db.select().from(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.id, id));
    return record || null;
  }

  async update(id: string, data: Partial<typeof schema.webhookSubscriptions.$inferInsert>) {
    const db = getDatabase();
    const [record] = await db
      .update(schema.webhookSubscriptions)
      .set({ ...data, updated_at: new Date() })
      .where(eq(schema.webhookSubscriptions.id, id))
      .returning();
    return record || null;
  }

  async delete(id: string) {
    const db = getDatabase();
    await db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.id, id));
  }
}

export function createWebhookRepository(): WebhookRepository {
  return new WebhookRepository();
}
