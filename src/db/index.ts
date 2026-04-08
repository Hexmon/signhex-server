import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config as appConfig } from '@/config';
import * as schema from './schema.js';

let db: ReturnType<typeof drizzle> | null = null;
let pool: Pool | null = null;

export async function initializeDatabase(): Promise<void> {
  if (db) return;

  const connectionString = appConfig.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  pool = new Pool({
    connectionString,
  });

  db = drizzle(pool, { schema });
}

export function getDatabase(): ReturnType<typeof drizzle> {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export function getDatabasePool() {
  return pool;
}

export { schema };

export async function closeDatabase() {
  await pool?.end();
  pool = null;
  db = null;
}
