import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';
import { hashPassword } from '@/auth/password';
import { backfillLegacyConversationsToChat } from '@/chat/backfill-legacy';
import { testRoles } from '@/test/helpers';

async function applyMigrationFile(filename: string) {
  const db = getDatabase();
  const migrationPath = path.resolve(process.cwd(), 'drizzle', 'migrations', filename);
  const content = await readFile(migrationPath, 'utf8');
  const statements = content
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function tableExists(tableName: string) {
  const db = getDatabase();
  const result = await db.execute<{ regclass: string | null }>(
    sql`SELECT to_regclass(${`public.${tableName}`}) AS regclass`
  );
  const first = result.rows[0] as { regclass?: string | null } | undefined;
  return Boolean(first?.regclass);
}

describe('Legacy conversation backfill', () => {
  beforeAll(async () => {
    await initializeDatabase();
    const db = getDatabase();
    await db
      .insert(schema.roles)
      .values([
        {
          id: testRoles.ADMIN.id,
          name: testRoles.ADMIN.name,
          permissions: {},
          is_system: true,
        },
        {
          id: testRoles.OPERATOR.id,
          name: testRoles.OPERATOR.name,
          permissions: {},
          is_system: true,
        },
      ])
      .onConflictDoNothing();
    if (!(await tableExists('chat_conversations'))) {
      await applyMigrationFile('0008_chat_core.sql');
    }
    await applyMigrationFile('0012_chat_dm_pair_active_unique.sql');
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('is idempotent and does not duplicate members/messages', async () => {
    const db = getDatabase();
    const participantA = randomUUID();
    const participantB = randomUUID();
    const legacyConversationId = randomUUID();
    const legacyMessageIdA = randomUUID();
    const legacyMessageIdB = randomUUID();
    const now = new Date();

    const passwordHash = await hashPassword('Password123!');
    await db.insert(schema.users).values([
      {
        id: participantA,
        email: `legacy-backfill-a-${Date.now()}@example.com`,
        password_hash: passwordHash,
        first_name: 'Legacy',
        last_name: 'A',
        role_id: testRoles.OPERATOR.id,
        is_active: true,
      },
      {
        id: participantB,
        email: `legacy-backfill-b-${Date.now()}@example.com`,
        password_hash: passwordHash,
        first_name: 'Legacy',
        last_name: 'B',
        role_id: testRoles.OPERATOR.id,
        is_active: true,
      },
    ]);

    await db.insert(schema.conversations).values({
      id: legacyConversationId,
      participant_a: participantA < participantB ? participantA : participantB,
      participant_b: participantA < participantB ? participantB : participantA,
      created_at: now,
      updated_at: now,
    });

    await db.insert(schema.conversationMessages).values([
      {
        id: legacyMessageIdA,
        conversation_id: legacyConversationId,
        author_id: participantA,
        content: 'legacy message A',
        attachments: null,
        created_at: new Date(now.getTime() + 1000),
      },
      {
        id: legacyMessageIdB,
        conversation_id: legacyConversationId,
        author_id: participantB,
        content: 'legacy message B',
        attachments: [{ foo: 'bar' }],
        created_at: new Date(now.getTime() + 2000),
      },
    ]);

    await db.insert(schema.conversationReads).values({
      conversation_id: legacyConversationId,
      user_id: participantA,
      last_read_at: new Date(now.getTime() + 1500),
    });

    await backfillLegacyConversationsToChat();
    await backfillLegacyConversationsToChat();

    const [chatConversation] = await db
      .select()
      .from(schema.chatConversations)
      .where(eq(schema.chatConversations.id, legacyConversationId))
      .limit(1);
    expect(chatConversation).toBeTruthy();
    expect(chatConversation?.type).toBe('DM');

    const members = await db
      .select()
      .from(schema.chatMembers)
      .where(eq(schema.chatMembers.conversation_id, legacyConversationId));
    expect(members.length).toBe(2);

    const [messageA] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, legacyMessageIdA))
      .limit(1);
    const [messageB] = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, legacyMessageIdB))
      .limit(1);
    expect(messageA?.conversation_id).toBe(legacyConversationId);
    expect(messageB?.conversation_id).toBe(legacyConversationId);

    const receipts = await db
      .select()
      .from(schema.chatReceipts)
      .where(
        and(
          eq(schema.chatReceipts.conversation_id, legacyConversationId),
          eq(schema.chatReceipts.user_id, participantA)
        )
      );
    expect(receipts.length).toBe(1);
  });
});
