import { createHash } from 'crypto';
import { initializeDatabase, getDatabase } from '@/db';
import { config as appConfig } from '@/config';
import { sql } from 'drizzle-orm';

const QUEUE_NAMES = ['cleanup', 'archive', 'chat:media-cleanup'] as const;

function getPartitionName(queueName: string) {
  return `j${createHash('sha224').update(queueName).digest('hex')}`;
}

async function main() {
  await initializeDatabase();
  const db = getDatabase();
  const schemaSql = `"${appConfig.PG_BOSS_SCHEMA.replace(/"/g, '""')}"`;

  for (const queueName of QUEUE_NAMES) {
    const partitionName = getPartitionName(queueName);
    const result = await db.execute(sql.raw(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_tables
        WHERE schemaname = '${appConfig.PG_BOSS_SCHEMA.replace(/'/g, "''")}'
          AND tablename = '${partitionName}'
      ) AS exists
    `));

    const partitionExists = Boolean((result as { rows?: Array<{ exists?: boolean }> }).rows?.[0]?.exists);
    if (!partitionExists) {
      console.log(`skip ${queueName}: partition table ${partitionName} not found`);
      continue;
    }

    await db.execute(sql.raw(`
      INSERT INTO ${schemaSql}.queue (
        name,
        policy,
        partition_name
      )
      VALUES (
        '${queueName.replace(/'/g, "''")}',
        'standard',
        '${partitionName}'
      )
      ON CONFLICT (name) DO NOTHING
    `));

    console.log(`repaired ${queueName}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
