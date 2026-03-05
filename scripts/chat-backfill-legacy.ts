#!/usr/bin/env tsx

import { initializeDatabase, closeDatabase } from '../src/db/index.js';
import { backfillLegacyConversationsToChat } from '../src/chat/backfill-legacy.js';

async function main() {
  await initializeDatabase();
  try {
    const stats = await backfillLegacyConversationsToChat();
    console.log('Chat legacy backfill completed');
    console.table(stats);
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('Chat legacy backfill failed:', error);
  process.exit(1);
});
