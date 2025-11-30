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

  describe('POST /v1/auth/login', () => {
    it('should return 400 for invalid email', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'invalid-email',
          password: 'password123',
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    });

    it('should return 401 for invalid credentials', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'wrongpassword',
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should return JWT token for valid credentials', async () => {
      // This test assumes a test user exists in the database
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: testUser.email,
          password: testUser.password,
        },
      });

      expect(response.statusCode).toBe(HTTP_STATUS.OK);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('access_token');
      expect(body).toHaveProperty('expires_in');
    });
  });

  describe('GET /v1/auth/me', () => {
    it('should return 401 without authorization header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/auth/me',
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should return 401 with invalid token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/auth/me',
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
        url: '/v1/auth/me',
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
  });

  describe('POST /v1/auth/logout', () => {
    it('should return 401 without authorization header', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
      });

      expect(response.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });

    it('should revoke token on logout', async () => {
      const token = await generateTestToken(testUser.id);

      // First logout
      const logoutResponse = await server.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(logoutResponse.statusCode).toBe(HTTP_STATUS.OK);

      // Try to use the same token again
      const meResponse = await server.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(meResponse.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    });
  });
});
