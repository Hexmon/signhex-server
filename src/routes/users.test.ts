import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createTestServer, generateTestToken, testUser } from '@/test/helpers';

describe('User Routes', () => {
  let server: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    server = await createTestServer();
    adminToken = await generateTestToken(testUser.id, 'ADMIN');
  });

  afterAll(async () => {
    await server.close();
  });

  describe('POST /v1/users', () => {
    it('should return 401 without authorization', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/users',
        payload: {
          email: 'newuser@example.com',
          password: 'Password123!',
          first_name: 'New',
          last_name: 'User',
          role: 'OPERATOR',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should create user with valid admin token', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          email: 'newuser@example.com',
          password: 'Password123!',
          first_name: 'New',
          last_name: 'User',
          role: 'OPERATOR',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('id');
      expect(body.email).toBe('newuser@example.com');
      expect(body.role).toBe('OPERATOR');
    });

    it('should return 400 for invalid email', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          email: 'invalid-email',
          password: 'Password123!',
          first_name: 'New',
          last_name: 'User',
          role: 'OPERATOR',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/users', () => {
    it('should return 401 without authorization', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/users',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should list users with valid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/users',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('pagination');
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('should support pagination', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/users?page=1&limit=10',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(10);
    });
  });

  describe('GET /v1/users/:id', () => {
    it('should return 401 without authorization', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/v1/users/${testUser.id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 404 for non-existent user', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/users/non-existent-id',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should get user by ID', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/v1/users/${testUser.id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(testUser.id);
    });
  });
});

