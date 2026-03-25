#!/usr/bin/env tsx

import { initializeDatabase, closeDatabase } from '../src/db/index.js';
import { createNotificationCounterRepository } from '../src/db/repositories/notification-counter.js';

function getUserIdArg(argv: string[]): string | undefined {
  const fromFlag = argv.find((arg) => arg.startsWith('--userId='));
  if (fromFlag) return fromFlag.split('=')[1];
  const fromShort = argv.find((arg) => arg.startsWith('--user='));
  if (fromShort) return fromShort.split('=')[1];
  return undefined;
}

async function main() {
  await initializeDatabase();
  const counterRepo = createNotificationCounterRepository();
  const userId = getUserIdArg(process.argv.slice(2));

  try {
    if (userId) {
      const unread_total = await counterRepo.reconcile(userId);
      console.log(
        JSON.stringify(
          {
            mode: 'single-user',
            userId,
            unread_total,
          },
          null,
          2
        )
      );
      return;
    }

    const results = await counterRepo.reconcileAllUserCounters();
    const totalUnread = results.reduce((sum, row) => sum + row.unread_total, 0);
    console.log(
      JSON.stringify(
        {
          mode: 'all-users',
          users: results.length,
          totalUnread,
        },
        null,
        2
      )
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('Notification counter reconcile failed:', error);
  process.exit(1);
});
