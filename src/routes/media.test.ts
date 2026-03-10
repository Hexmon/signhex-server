import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createServer } from '@/server';
import { generateAccessToken } from '@/auth/jwt';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';
import { createSessionRepository } from '@/db/repositories/session';
import { hashPassword } from '@/auth/password';
import { HTTP_STATUS } from '@/http-status-codes';

type RolePermissions = {
  grants: Array<{ action: string; subject: string }>;
};

describe('Media Routes - delete ownership and usage protection', () => {
  let server: FastifyInstance;
  let ownerToken: string;
  let otherUserToken: string;
  let adminToken: string;
  let superAdminToken: string;
  let ownerUserId: string;
  let otherUserId: string;
  let adminUserId: string;
  let superAdminUserId: string;

  beforeAll(async () => {
    await initializeDatabase();
    server = await createServer();

    const db = getDatabase();
    const ensureRole = async (name: string, permissions: RolePermissions) => {
      const [existing] = await db
        .select()
        .from(schema.roles)
        .where(eq(schema.roles.name, name))
        .limit(1);

      if (existing) {
        const currentPermissions =
          existing.permissions && typeof existing.permissions === 'object'
            ? (existing.permissions as RolePermissions)
            : { grants: [] };
        const mergedGrants = [...currentPermissions.grants];
        for (const grant of permissions.grants) {
          if (
            !mergedGrants.some(
              (current) =>
                current.action === grant.action && current.subject === grant.subject
            )
          ) {
            mergedGrants.push(grant);
          }
        }

        const [updated] = await db
          .update(schema.roles)
          .set({ permissions: { grants: mergedGrants } })
          .where(eq(schema.roles.id, existing.id))
          .returning();
        return updated ?? existing;
      }

      const [created] = await db
        .insert(schema.roles)
        .values({
          id: randomUUID(),
          name,
          permissions,
          is_system: true,
        })
        .returning();
      return created;
    };

    const mediaUserRole = await ensureRole(`MEDIA_DELETE_USER_${randomUUID()}`, {
      grants: [
        { action: 'read', subject: 'Media' },
        { action: 'delete', subject: 'Media' },
      ],
    });
    const adminRole = await ensureRole('ADMIN', {
      grants: [
        { action: 'read', subject: 'Media' },
        { action: 'delete', subject: 'Media' },
      ],
    });
    const superAdminRole = await ensureRole('SUPER_ADMIN', { grants: [] });

    const createUser = async (params: {
      email: string;
      firstName: string;
      lastName: string;
      roleId: string;
    }) => {
      const id = randomUUID();
      await db.insert(schema.users).values({
        id,
        email: params.email,
        password_hash: await hashPassword('Password123!'),
        first_name: params.firstName,
        last_name: params.lastName,
        role_id: params.roleId,
        is_active: true,
      });
      return id;
    };

    ownerUserId = await createUser({
      email: `media-owner-${Date.now()}@example.com`,
      firstName: 'Priya',
      lastName: 'Sharma',
      roleId: mediaUserRole.id,
    });
    otherUserId = await createUser({
      email: `media-other-${Date.now()}@example.com`,
      firstName: 'Amit',
      lastName: 'Khan',
      roleId: mediaUserRole.id,
    });
    adminUserId = await createUser({
      email: `media-admin-${Date.now()}@example.com`,
      firstName: 'Admin',
      lastName: 'User',
      roleId: adminRole.id,
    });
    superAdminUserId = await createUser({
      email: `media-super-${Date.now()}@example.com`,
      firstName: 'Super',
      lastName: 'Admin',
      roleId: superAdminRole.id,
    });

    const issueToken = async (userId: string, email: string, roleId: string, roleName: string) => {
      const token = await generateAccessToken(userId, email, roleId, roleName);
      await createSessionRepository().create({
        user_id: userId,
        access_jti: token.jti,
        expires_at: token.expiresAt,
      });
      return token.token;
    };

    ownerToken = await issueToken(
      ownerUserId,
      `owner-${ownerUserId}@example.com`,
      mediaUserRole.id,
      mediaUserRole.name
    );
    otherUserToken = await issueToken(
      otherUserId,
      `other-${otherUserId}@example.com`,
      mediaUserRole.id,
      mediaUserRole.name
    );
    adminToken = await issueToken(
      adminUserId,
      `admin-${adminUserId}@example.com`,
      adminRole.id,
      adminRole.name
    );
    superAdminToken = await issueToken(
      superAdminUserId,
      `super-${superAdminUserId}@example.com`,
      superAdminRole.id,
      superAdminRole.name
    );
  });

  afterAll(async () => {
    await server.close();
    await closeDatabase();
  });

  const insertMedia = async (createdBy: string) => {
    const db = getDatabase();
    const [media] = await db
      .insert(schema.media)
      .values({
        id: randomUUID(),
        name: `media-${Date.now()}`,
        type: 'IMAGE',
        status: 'READY',
        created_by: createdBy,
      })
      .returning();
    return media;
  };

  it('returns 401 without authorization', async () => {
    const media = await insertMedia(ownerUserId);
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}`,
    });

    expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('soft deletes uploader owned media', async () => {
    const media = await insertMedia(ownerUserId);
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.id).toBe(media.id);
    expect(body.message).toContain('Media soft deleted');
    expect(Array.isArray(body.storage_deleted)).toBe(true);

    const db = getDatabase();
    const [updated] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, media.id));
    expect(updated).toBeTruthy();
    expect(updated?.status).toBe('FAILED');
    expect(updated?.source_bucket).toBeNull();
    expect(updated?.source_object_key).toBeNull();
  });

  it('hard deletes uploader owned media when not referenced', async () => {
    const media = await insertMedia(ownerUserId);
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}?hard=true`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const body = JSON.parse(response.body);
    expect(body.id).toBe(media.id);
    expect(body.message).toContain('Media hard deleted');

    const db = getDatabase();
    const [deleted] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, media.id));
    expect(deleted).toBeUndefined();
  });

  it('blocks non-owner delete and exposes uploader identity', async () => {
    const media = await insertMedia(ownerUserId);
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}?hard=true`,
      headers: {
        authorization: `Bearer ${otherUserToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('MEDIA_DELETE_FORBIDDEN_OWNER');
    expect(body.error.message).toContain('Priya Sharma');
    expect(body.error.details.owner_user_id).toBe(ownerUserId);
    expect(body.error.details.owner_display_name).toBe('Priya Sharma');
  });

  it('allows ADMIN to delete another user media', async () => {
    const media = await insertMedia(ownerUserId);
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}?hard=true`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const db = getDatabase();
    const [deleted] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, media.id));
    expect(deleted).toBeUndefined();
  });

  it('allows SUPER_ADMIN to delete another user media', async () => {
    const media = await insertMedia(ownerUserId);
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}?hard=true`,
      headers: {
        authorization: `Bearer ${superAdminToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.OK);
    const db = getDatabase();
    const [deleted] = await db
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, media.id));
    expect(deleted).toBeUndefined();
  });

  it('returns 409 when media is referenced by chat attachments', async () => {
    const db = getDatabase();
    const media = await insertMedia(ownerUserId);
    const conversationId = randomUUID();
    const messageId = randomUUID();

    await db.insert(schema.chatConversations).values({
      id: conversationId,
      type: 'GROUP_CLOSED',
      title: 'Referenced media conversation',
      created_by: ownerUserId,
      state: 'ACTIVE',
      invite_policy: 'ANY_MEMBER_CAN_INVITE',
      last_seq: 1,
      metadata: {},
    });
    await db.insert(schema.chatMessages).values({
      id: messageId,
      conversation_id: conversationId,
      seq: 1,
      sender_id: ownerUserId,
      body_text: 'Message with attachment',
    });
    await db.insert(schema.chatAttachments).values({
      id: randomUUID(),
      message_id: messageId,
      media_asset_id: media.id,
      kind: 'IMAGE',
      ord: 0,
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}?hard=true`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('MEDIA_IN_USE');
    expect(body.error.message).toBe(
      'Media cannot be deleted because it is still used by chat messages.'
    );
    expect(body.error.details.references).toContain('chat_attachments');
  });

  it('returns 409 when media is referenced by a non-chat surface', async () => {
    const db = getDatabase();
    const media = await insertMedia(ownerUserId);
    const presentationId = randomUUID();

    await db.insert(schema.presentations).values({
      id: presentationId,
      name: `presentation-${Date.now()}`,
      created_by: ownerUserId,
    });
    await db.insert(schema.presentationItems).values({
      id: randomUUID(),
      presentation_id: presentationId,
      media_id: media.id,
      order: 0,
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${media.id}?hard=true`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('MEDIA_IN_USE');
    expect(body.error.message).toBe(
      'Media cannot be deleted because it is still used in presentations.'
    );
    expect(body.error.details.references).toContain('presentations');
  });

  it('returns 404 for missing media', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/media/${randomUUID()}?hard=true`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
      },
    });

    expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
