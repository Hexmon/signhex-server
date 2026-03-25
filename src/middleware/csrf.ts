import { FastifyPluginAsync } from 'fastify';
import { config as appConfig } from '@/config';
import { AppError } from '@/utils/app-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER_NAMES = ['x-csrf-token', 'x-xsrf-token'];
const CSRF_EXEMPT_PATHS = new Set([
  '/api/v1/device-pairing/request',
]);

export const csrfProtectionPlugin: FastifyPluginAsync = async (fastify) => {
  if (!appConfig.CSRF_ENABLED) return;

  fastify.addHook('preHandler', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;

    if (request.routerPath && CSRF_EXEMPT_PATHS.has(request.routerPath)) return;

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
      throw AppError.forbidden('Invalid CSRF token');
    }
  });
};

export default csrfProtectionPlugin;
