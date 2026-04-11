import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createTestServer, generateTestToken, testUser, closeTestServer } from '../test/helpers';
import { HTTP_STATUS } from '@/http-status-codes';

describe('Auth Routes', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  describe('POST /api/v1/auth/login', () => {
    it('should return 422 for invalid email', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'invalid-email',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_CONTENT);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(body.error.details)).toBe(true);
    });

    it('should return 401 for invalid credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('should return JWT token for valid credentials', async () => {
      // This test assumes a test user exists in the database
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          email: testUser.email,
          password: testUser.password,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.OK);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('user');
      expect(body).toHaveProperty('expiresAt');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should return 401 without authorization header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(response.headers['x-request-id']).toBeDefined();
      expect(body.error.traceId).toBe(response.headers['x-request-id']);
    });

    it('should return 401 with invalid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should return current user with valid token', async () => {
      const token = await generateTestToken(testUser.id);
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.OK);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('email');
      expect(body).toHaveProperty('role');
    });

    it('should accept access_token cookie when authorization header is absent', async () => {
      const token = await generateTestToken(testUser.id);

      const meResponse = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          cookie: `access_token=${token}`,
        },
      });

      expect(meResponse.statusCode).toBe(HTTP_STATUS.OK);
      expect(meResponse.headers['x-access-token']).toBeTruthy();

      const body = JSON.parse(meResponse.body);
      expect(body.id).toBe(testUser.id);
      expect(body.email).toBe(testUser.email);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('should return 401 without authorization header', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should revoke token on logout', async () => {
      const token = await generateTestToken(testUser.id);

      // First logout
      const logoutResponse = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(logoutResponse.statusCode).toBe(HTTP_STATUS.OK);

      // Try to use the same token again
      const meResponse = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(meResponse.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });
});
