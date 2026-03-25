import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createServer } from '@/server';
import { closeDatabase, getDatabase, initializeDatabase, schema } from '@/db';
import { generateAccessToken } from '@/auth/jwt';
import { createSessionRepository } from '@/db/repositories/session';
import { hashPassword } from '@/auth/password';
import { SYSTEM_ROLE_DEFAULTS } from '@/rbac/system-roles';
import { HTTP_STATUS } from '@/http-status-codes';

describe('Layout Routes - admin created shared layouts', () => {
  let server: FastifyInstance;
  let adminToken: string;
  let operatorToken: string;
  let adminUserId: string;
  let operatorUserId: string;
  let adminRoleId: string;
  let operatorRoleId: string;

  beforeAll(async () => {
    await initializeDatabase();
    server = await createServer();
    const db = getDatabase();

    const ensureRole = async (name: 'ADMIN' | 'OPERATOR', permissions: typeof SYSTEM_ROLE_DEFAULTS.ADMIN) => {
      const [existing] = await db.select().from(schema.roles).where(eq(schema.roles.name, name)).limit(1);
      if (existing) {
        return existing;
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

    const adminRole = await ensureRole('ADMIN', SYSTEM_ROLE_DEFAULTS.ADMIN);
    const operatorRole = await ensureRole('OPERATOR', SYSTEM_ROLE_DEFAULTS.OPERATOR);
    adminRoleId = adminRole.id;
    operatorRoleId = operatorRole.id;

    const createUser = async (roleId: string, email: string) => {
      const id = randomUUID();
      await db.insert(schema.users).values({
        id,
        email,
        password_hash: await hashPassword('Password123!'),
        role_id: roleId,
        is_active: true,
      });
      return id;
    };

    adminUserId = await createUser(adminRoleId, `layout-admin-${Date.now()}@example.com`);
    operatorUserId = await createUser(operatorRoleId, `layout-operator-${Date.now()}@example.com`);

    const issueToken = async (userId: string, roleId: string, roleName: string, email: string) => {
      const issued = await generateAccessToken(userId, email, roleId, roleName);
      await createSessionRepository().create({
        user_id: userId,
        access_jti: issued.jti,
        expires_at: issued.expiresAt,
      });
      return issued.token;
    };

    adminToken = await issueToken(adminUserId, adminRoleId, 'ADMIN', `admin-${adminUserId}@example.com`);
    operatorToken = await issueToken(operatorUserId, operatorRoleId, 'OPERATOR', `operator-${operatorUserId}@example.com`);
  });

  afterAll(async () => {
    await server.close();
    await closeDatabase();
  });

  it('shows admin-created layouts to operators but blocks edits', async () => {
    const db = getDatabase();
    const [layout] = await db
      .insert(schema.layouts)
      .values({
        id: randomUUID(),
        name: `Shared Layout ${Date.now()}`,
        description: 'Admin shared layout',
        aspect_ratio: '16:9',
        spec: {
          slots: [{ id: 'hero', x: 0, y: 0, w: 1, h: 1 }],
        },
        created_by: adminUserId,
      })
      .returning();

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/layouts',
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
    });

    expect(listResponse.statusCode).toBe(HTTP_STATUS.OK);
    const listBody = JSON.parse(listResponse.body);
    expect(listBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: layout.id,
          is_shared: true,
        }),
      ])
    );

    const getResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/layouts/${layout.id}`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
    });

    expect(getResponse.statusCode).toBe(HTTP_STATUS.OK);
    const getBody = JSON.parse(getResponse.body);
    expect(getBody.is_shared).toBe(true);

    const patchResponse = await server.inject({
      method: 'PATCH',
      url: `/api/v1/layouts/${layout.id}`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
      payload: {
        name: 'Operator edit attempt',
      },
    });

    expect(patchResponse.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
  });
});
