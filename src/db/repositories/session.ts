import { eq, and } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';

export class SessionRepository {
  async create(data: {
    user_id: string;
    access_jti: string;
    expires_at: Date;
  }) {
    const db = getDatabase();
    const result = await db.insert(schema.sessions).values(data).returning();
    return result[0];
  }

  async findByJti(jti: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.access_jti, jti));
    return result[0] || null;
  }

  async findByUserId(userId: string) {
    const db = getDatabase();
    const result = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.user_id, userId));
    return result;
  }

  async revokeByJti(jti: string) {
    const db = getDatabase();
    await db.delete(schema.sessions).where(eq(schema.sessions.access_jti, jti));
  }

  async revokeByUserId(userId: string) {
    const db = getDatabase();
    await db.delete(schema.sessions).where(eq(schema.sessions.user_id, userId));
  }

  async cleanupExpired() {
    const db = getDatabase();
    await db
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.expires_at, new Date())));
  }
}

export function createSessionRepository(): SessionRepository {
  return new SessionRepository();
}

