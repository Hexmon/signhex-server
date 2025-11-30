import { FastifyInstance } from 'fastify';
import { createServer } from '@/server';
import { initializeDatabase, closeDatabase, getDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { hashPassword } from '@/auth/password';
import { eq } from 'drizzle-orm';
import { createSessionRepository } from '@/db/repositories/session';

export async function createTestServer(): Promise<FastifyInstance> {
  await initializeDatabase();
  await seedTestData();
  const server = await createServer();
  server.addHook('onClose', async () => {
    await closeDatabase();
  });
  return server;
}

export async function generateTestToken(userId: string, role: 'ADMIN' | 'OPERATOR' | 'DEPARTMENT' = 'ADMIN') {
  const result = await generateAccessToken(userId, 'test@example.com', role);
  const sessionRepo = createSessionRepository();
  await sessionRepo.create({
    user_id: userId,
    access_jti: result.jti,
    expires_at: result.expiresAt,
  });
  return result.token;
}

export async function cleanupDatabase() {
  // const db = getDatabase();
  // Clean up test data
  // This should be implemented based on your database schema
}

export async function seedTestData() {
  const db = getDatabase();

  await db.delete(schema.users).where(eq(schema.users.email, testUser.email));

  const passwordHash = await hashPassword(testUser.password);
  await db.insert(schema.users).values({
    id: testUser.id,
    email: testUser.email,
    password_hash: passwordHash,
    first_name: testUser.first_name,
    last_name: testUser.last_name,
    role: testUser.role,
    is_active: true,
  });
}

export async function closeTestServer(server: FastifyInstance) {
  await server.close();
  await closeDatabase();
}

export const testUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'test@example.com',
  password: 'TestPassword123!',
  first_name: 'Test',
  last_name: 'User',
  role: 'ADMIN' as const,
};

export const testMedia = {
  id: 'test-media-1',
  name: 'Test Video',
  type: 'VIDEO' as const,
};

export const testScreen = {
  id: 'test-screen-1',
  name: 'Test Screen',
  location: 'Test Location',
};

export const testSchedule = {
  id: 'test-schedule-1',
  name: 'Test Schedule',
  description: 'Test schedule description',
};
