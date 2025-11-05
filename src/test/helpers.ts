import { FastifyInstance } from 'fastify';
import { createServer } from '@/server';
import { getConfig } from '@/config';
import { getDatabase } from '@/db';
import { generateAccessToken } from '@/auth/jwt';

export async function createTestServer(): Promise<FastifyInstance> {
  const server = await createServer();
  return server;
}

export async function generateTestToken(userId: string, role: 'ADMIN' | 'OPERATOR' | 'DEPARTMENT' = 'ADMIN') {
  const result = await generateAccessToken(userId, 'test@example.com', role);
  return result.token;
}

export async function cleanupDatabase() {
  const db = getDatabase();
  // Clean up test data
  // This should be implemented based on your database schema
}

export async function seedTestData() {
  const db = getDatabase();
  // Seed test data
  // This should be implemented based on your database schema
}

export const testUser = {
  id: 'test-user-1',
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

