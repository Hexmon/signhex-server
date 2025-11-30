import { FastifyPluginAsync } from 'fastify';
import { HTTP_STATUS } from '@/http-status-codes';
import { config as appConfig } from '@/config';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER_NAMES = ['x-csrf-token', 'x-xsrf-token'];

export const csrfProtectionPlugin: FastifyPluginAsync = async (fastify) => {
  if (!appConfig.CSRF_ENABLED) return;

  fastify.addHook('preHandler', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;

    // Skip CSRF check for token-based auth without cookies
    const hasAuthHeader = Boolean(request.headers.authorization);
    const hasCookies = Boolean((request as any).cookies);
    const accessTokenCookie = hasCookies ? (request as any).cookies['access_token'] : undefined;
    if (!accessTokenCookie && hasAuthHeader) return;

    // Allow login to issue fresh cookies without CSRF header
    if (request.routerPath && request.routerPath.includes('/auth/login')) return;

    const csrfCookie = hasCookies ? (request as any).cookies['csrf_token'] : undefined;
    const csrfHeader = CSRF_HEADER_NAMES.map((name) => request.headers[name] as string | undefined).find(Boolean);

    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return reply
        .status(HTTP_STATUS.FORBIDDEN)
        .send({ error: 'Invalid CSRF token' });
    }
  });
};

export default csrfProtectionPlugin;
