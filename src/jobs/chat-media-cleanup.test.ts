import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';

const deleteObjectMock = vi.fn();

vi.mock('@/s3', async () => {
  const actual = await vi.importActual<typeof import('@/s3')>('@/s3');
  return {
    ...actual,
    deleteObject: deleteObjectMock,
  };
});

const { cleanupChatMediaAssets } = await import('@/jobs');

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

describe('cleanupChatMediaAssets', () => {
  beforeAll(async () => {
    await initializeDatabase();
    if (!(await tableExists('chat_conversations'))) {
      await applyMigrationFile('0008_chat_core.sql');
    }
    await applyMigrationFile('0013_chat_fk_integrity.sql');
    await applyMigrationFile('0014_chat_pins_bookmarks_and_also_to_channel.sql');
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(() => {
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);
  });

  it('deletes media and storage rows when no references remain', async () => {
    const db = getDatabase();
    const mediaId = randomUUID();
    const readyObjectId = randomUUID();
    const thumbnailObjectId = randomUUID();

    await db.insert(schema.storageObjects).values([
      {
        id: readyObjectId,
        bucket: 'media-ready',
        object_key: `ready/${mediaId}.mp4`,
      },
      {
        id: thumbnailObjectId,
        bucket: 'media-thumbnails',
        object_key: `thumb/${mediaId}.jpg`,
      },
    ]);

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Cleanup Target',
      type: 'VIDEO',
      status: 'READY',
      created_by: randomUUID(),
      source_bucket: 'media-source',
      source_object_key: `source/${mediaId}.mp4`,
      ready_object_id: readyObjectId,
      thumbnail_object_id: thumbnailObjectId,
    });

    await cleanupChatMediaAssets({
      mediaAssetIds: [mediaId],
      source: 'message-delete',
      messageId: randomUUID(),
    });

    expect(deleteObjectMock).toHaveBeenCalledWith('media-source', `source/${mediaId}.mp4`);
    expect(deleteObjectMock).toHaveBeenCalledWith('media-ready', `ready/${mediaId}.mp4`);
    expect(deleteObjectMock).toHaveBeenCalledWith('media-thumbnails', `thumb/${mediaId}.jpg`);

    const [deletedMedia] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, mediaId));
    expect(deletedMedia).toBeUndefined();

    const storageRows = await db
      .select()
      .from(schema.storageObjects)
      .where(inArray(schema.storageObjects.id, [readyObjectId, thumbnailObjectId]));
    expect(storageRows).toHaveLength(0);
  });

  it('skips cleanup when media is still referenced by chat bookmarks', async () => {
    const db = getDatabase();
    const mediaId = randomUUID();
    const conversationId = randomUUID();
    const userId = randomUUID();
    const roleId = randomUUID();

    await db.insert(schema.roles).values({
      id: roleId,
      name: `JOB_TEST_ROLE_${randomUUID()}`,
      permissions: {},
      is_system: false,
    });

    await db.insert(schema.users).values({
      id: userId,
      email: `bookmark-owner-${Date.now()}@example.com`,
      password_hash: 'hash',
      role_id: roleId,
      is_active: true,
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Bookmarked Media',
      type: 'IMAGE',
      status: 'READY',
      created_by: userId,
      source_bucket: 'media-source',
      source_object_key: `bookmark/${mediaId}.png`,
    });

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'GROUP_CLOSED',
      created_by: userId,
      state: 'ACTIVE',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      metadata: {},
    });

    await db.insert(schema.chatBookmarks).values({
      id: randomUUID(),
      conversation_id: conversationId,
      type: 'FILE',
      label: 'Pinned file',
      media_asset_id: mediaId,
      created_by: userId,
    });

    await cleanupChatMediaAssets({
      mediaAssetIds: [mediaId],
      conversationId,
      source: 'message-delete',
    });

    const [media] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, mediaId));
    expect(media).toBeTruthy();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('skips cleanup when media is still referenced by non-chat surfaces', async () => {
    const db = getDatabase();
    const mediaId = randomUUID();
    const presentationId = randomUUID();
    const creatorId = randomUUID();

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Presentation Media',
      type: 'IMAGE',
      status: 'READY',
      created_by: creatorId,
      source_bucket: 'media-source',
      source_object_key: `presentation/${mediaId}.png`,
    });

    await db.insert(schema.presentations).values({
      id: presentationId,
      name: 'Presentation',
      created_by: creatorId,
    });

    await db.insert(schema.presentationItems).values({
      id: randomUUID(),
      presentation_id: presentationId,
      media_id: mediaId,
      order: 0,
    });

    await cleanupChatMediaAssets({
      mediaAssetIds: [mediaId],
      source: 'message-delete',
    });

    const [media] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, mediaId));
    expect(media).toBeTruthy();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it('does not delete db rows when object deletion fails', async () => {
    const db = getDatabase();
    const mediaId = randomUUID();
    const readyObjectId = randomUUID();

    await db.insert(schema.storageObjects).values({
      id: readyObjectId,
      bucket: 'media-ready',
      object_key: `broken/${mediaId}.mp4`,
    });

    await db.insert(schema.media).values({
      id: mediaId,
      name: 'Failing Cleanup Target',
      type: 'VIDEO',
      status: 'READY',
      created_by: randomUUID(),
      ready_object_id: readyObjectId,
    });

    deleteObjectMock.mockRejectedValueOnce(new Error('minio delete failed'));

    await cleanupChatMediaAssets({
      mediaAssetIds: [mediaId],
      source: 'message-delete',
    });

    const [media] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, mediaId));
    expect(media).toBeTruthy();

    const [storageRow] = await db
      .select()
      .from(schema.storageObjects)
      .where(eq(schema.storageObjects.id, readyObjectId));
    expect(storageRow).toBeTruthy();
  });
});
