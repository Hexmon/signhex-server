import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createTestServer, testUser, closeTestServer } from '@/test/helpers';
import { HTTP_STATUS } from '@/http-status-codes';
import { getDatabase, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';

async function issueAdminToken() {
  const db = getDatabase();
  const [adminRole] = await db.select().from(schema.roles).where(eq(schema.roles.name, 'ADMIN')).limit(1);
  if (!adminRole) {
    throw new Error('ADMIN role is required for users route tests');
  }

  const currentPermissions =
    adminRole.permissions && typeof adminRole.permissions === 'object'
      ? (adminRole.permissions as { grants?: Array<{ action: string; subject: string }> })
      : {};
  const mergedGrants = [...(currentPermissions.grants || [])];

  for (const grant of [
    { action: 'create', subject: 'User' },
    { action: 'read', subject: 'User' },
    { action: 'update', subject: 'User' },
    { action: 'delete', subject: 'User' },
  ]) {
    if (!mergedGrants.some((current) => current.action === grant.action && current.subject === grant.subject)) {
      mergedGrants.push(grant);
    }
  }

  await db
    .update(schema.roles)
    .set({ permissions: { grants: mergedGrants } })
    .where(eq(schema.roles.id, adminRole.id));

  const token = await generateAccessToken(testUser.id, testUser.email, adminRole.id, adminRole.name);
  await createSessionRepository().create({
    user_id: testUser.id,
    access_jti: token.jti,
    expires_at: token.expiresAt,
  });
  return token.token;
}

async function getRoleIdByName(name: string) {
  const db = getDatabase();
  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1);
  if (!role) {
    throw new Error(`${name} role is required for users route tests`);
  }
  return role.id;
}

describe('User Routes', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await issueAdminToken();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  describe('POST /api/v1/users', () => {
    it('should return 401 without authorization', async () => {
      const operatorRoleId = await getRoleIdByName('OPERATOR');
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/users',
        payload: {
          email: 'newuser@example.com',
          password: 'Password123!',
          first_name: 'New',
          last_name: 'User',
          role_id: operatorRoleId,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should create user with valid admin token', async () => {
      const uniqueEmail = `newuser+${Date.now()}@example.com`;
      const operatorRoleId = await getRoleIdByName('OPERATOR');
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          email: uniqueEmail,
          password: 'Password123!',
          first_name: 'New',
          last_name: 'User',
          role_id: operatorRoleId,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.CREATED);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('id');
      expect(body.email).toBe(uniqueEmail);
      expect(body.role_id).toBe(operatorRoleId);
    });

    it('should return 422 for invalid email', async () => {
      const operatorRoleId = await getRoleIdByName('OPERATOR');
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          email: 'invalid-email',
          password: 'Password123!',
          first_name: 'New',
          last_name: 'User',
          role_id: operatorRoleId,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_CONTENT);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/users', () => {
    it('should return 401 without authorization', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/users',
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should list users with valid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.OK);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('pagination');
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('should support pagination', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/users?page=1&limit=10',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.OK);
      const body = JSON.parse(response.body);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(10);
    });

    it('should filter users by role name in the database query', async () => {
      const operatorEmail = `operator-${Date.now()}@example.com`;
      const adminEmail = `admin-${Date.now()}@example.com`;
      const operatorRoleId = await getRoleIdByName('OPERATOR');
      const adminRoleId = await getRoleIdByName('ADMIN');

      await server.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          email: operatorEmail,
          password: 'Password123!',
          first_name: 'Operator',
          last_name: 'User',
          role_id: operatorRoleId,
        },
      });

      await server.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          email: adminEmail,
          password: 'Password123!',
          first_name: 'Admin',
          last_name: 'User',
          role_id: adminRoleId,
        },
      });

      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/users?role=OPERATOR',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.OK);
      const body = JSON.parse(response.body);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.some((user: any) => user.email === operatorEmail)).toBe(true);
      expect(body.items.some((user: any) => user.email === adminEmail)).toBe(false);
      expect(body.items.every((user: any) => user.role === 'OPERATOR')).toBe(true);
    });

  });

  describe('GET /api/v1/users/:id', () => {
    it('should return 401 without authorization', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/users/${testUser.id}`,
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should return 404 for non-existent user', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/users/00000000-0000-0000-0000-000000000099',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    });

    it('should get user by ID', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/users/${testUser.id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.OK);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(testUser.id);
    });
  });

  describe('DELETE /api/v1/users/:id', () => {
    it('should return a conflict with reference details when the user is still linked', async () => {
      const operatorRoleId = await getRoleIdByName('OPERATOR');
      const createResponse = await server.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          email: `delete-linked-${Date.now()}@example.com`,
          password: 'Password123!',
          first_name: 'Participant',
          last_name: 'User',
          role_id: operatorRoleId,
        },
      });

      expect(createResponse.statusCode).toBe(HTTP_STATUS.CREATED);
      const createdUser = JSON.parse(createResponse.body) as { id: string };
      const db = getDatabase();
      const [conversation] = await db
        .insert(schema.chatConversations)
        .values({
          type: 'GROUP_CLOSED',
          title: 'Delete Reference Test',
          created_by: testUser.id,
        })
        .returning();

      await db.insert(schema.chatMembers).values({
        conversation_id: conversation.id,
        user_id: createdUser.id,
        role: 'MEMBER',
      });

      const response = await server.inject({
        method: 'DELETE',
        url: `/api/v1/users/${createdUser.id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.CONFLICT);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.message).toContain('chat memberships');
      expect(body.error.details.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'chat_members',
            label: 'chat memberships',
          }),
        ])
      );
    });
  });
});
