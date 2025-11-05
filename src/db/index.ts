import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

let db: ReturnType<typeof drizzle> | null = null;

export async function initializeDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  const pool = new Pool({
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

export { schema };

