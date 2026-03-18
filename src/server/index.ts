import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyCookie from '@fastify/cookie';
import { config as appConfig } from '@/config';
import { authRoutes } from '@/routes/auth';
import { userRoutes } from '@/routes/users';
import { mediaRoutes } from '@/routes/media';
import { scheduleRoutes } from '@/routes/schedules';
import { screenRoutes } from '@/routes/screens';
import { departmentRoutes } from '@/routes/departments';
import { auditLogRoutes } from '@/routes/audit-logs';
import { requestRoutes } from '@/routes/requests';
import { emergencyRoutes } from '@/routes/emergency';
import { notificationRoutes } from '@/routes/notifications';
import { presentationRoutes } from '@/routes/presentations';
import { devicePairingRoutes } from '@/routes/device-pairing';
import { deviceTelemetryRoutes } from '@/routes/device-telemetry';
import { apiKeyRoutes } from '@/routes/api-keys';
import { webhookRoutes } from '@/routes/webhooks';
import { ssoConfigRoutes } from '@/routes/sso-config';
import { settingsRoutes } from '@/routes/settings';
import { conversationRoutes } from '@/routes/conversations';
import { proofOfPlayRoutes } from '@/routes/proof-of-play';
import { metricsRoutes } from '@/routes/metrics';
import { reportsRoutes } from '@/routes/reports';
import { userInviteRoutes } from '@/routes/users-invite';
import { userActivateRoutes } from '@/routes/users-activate';
import { layoutRoutes } from '@/routes/layouts';
import { screenGroupRoutes } from '@/routes/screen-groups';
import { scheduleRequestRoutes } from '@/routes/schedule-requests';
import { roleRoutes } from '@/routes/roles';
import { permissionRoutes } from '@/routes/permissions';
import { chatRoutes } from '@/routes/chat';
import csrfProtectionPlugin from '@/middleware/csrf';
import { formatErrorResponse } from '@/utils/app-error';
import { toAppError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { syncSystemRolePermissions } from '@/rbac/system-roles';
import { createSessionRepository } from '@/db/repositories/session';
import { extractTokenFromHeader, refreshAccessToken, verifyAccessToken } from '@/auth/jwt';
import { getIdleTimeoutSeconds, getRuntimeLogLevelSetting, preloadSettingsCache } from '@/utils/settings';
import { setRuntimeLogLevel } from '@/utils/logger';

const REFRESHED_AUTH_KEY = Symbol.for('signhex.refreshedAuth');

type RefreshedAuthState = {
  token: string;
  expiresAt: Date;
};

type RequestWithRefresh = FastifyRequest & {
  [REFRESHED_AUTH_KEY]?: RefreshedAuthState;
};

type BodySummary = {
  type: string;
  keys?: string[];
  length?: number;
  csr?: { length: number; prefix: string };
  pairing_code?: string;
  pairingCode?: string;
};

function redactValue(value: unknown) {
  if (typeof value !== 'string') return undefined;
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function summarizeRequestBody(body: unknown): BodySummary {
  if (body === null || body === undefined) return { type: 'empty' };
  if (Array.isArray(body)) return { type: 'array', length: body.length };
  if (typeof body !== 'object') return { type: typeof body };

  const obj = body as Record<string, unknown>;
  const summary: BodySummary = { type: 'object', keys: Object.keys(obj) };

  if (typeof obj.csr === 'string') {
    summary.csr = {
      length: obj.csr.length,
      prefix: obj.csr.slice(0, 32),
    };
  }
  if ('pairing_code' in obj) {
    summary.pairing_code = redactValue(obj.pairing_code);
  }
  if ('pairingCode' in obj) {
    summary.pairingCode = redactValue(obj.pairingCode);
  }
  return summary;
}

function sanitizeErrorMessage(message?: string) {
  if (!message) return '';
  let safe = message;
  safe = safe.replace(/([A-Za-z]:)?[\\/][^\\s'"]+/g, '<path>');
  safe = safe.replace(/(password|secret|token)=\\S+/gi, '$1=<redacted>');
  safe = safe.slice(0, 220);
  return safe;
}

export async function createServer() {
  await syncSystemRolePermissions();
  await preloadSettingsCache();
  setRuntimeLogLevel(getRuntimeLogLevelSetting());

  const fastify = Fastify({
    logger: {
      level: getRuntimeLogLevelSetting(),
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true, 
        },
      },
    },
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      if (Array.isArray(header) && header[0]) return header[0];
      if (typeof header === 'string' && header.length > 0) return header;
      return randomUUID();
    },
  });

  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  fastify.addHook('onRequest', async (request) => {
    const token = extractTokenFromHeader(request.headers.authorization);
    if (!token) return;

    const payload = await verifyAccessToken(token);
    const sessionRepo = createSessionRepository();
    const session = await sessionRepo.findByJti(payload.jti);
    if (!session || session.user_id !== payload.sub || session.expires_at.getTime() <= Date.now()) {
      throw AppError.unauthorized('Token has been revoked');
    }

    const expiresInSeconds = getIdleTimeoutSeconds();
    const refreshed = await refreshAccessToken(payload, expiresInSeconds);
    await sessionRepo.extendByJti(payload.jti, refreshed.expiresAt);
    (request as unknown as RequestWithRefresh)[REFRESHED_AUTH_KEY] = {
      token: refreshed.token,
      expiresAt: refreshed.expiresAt,
    };
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    const refreshed = (request as unknown as RequestWithRefresh)[REFRESHED_AUTH_KEY];
    if (!refreshed) return payload;

    const secure = appConfig.NODE_ENV !== 'development';
    const maxAge = Math.max(Math.floor((refreshed.expiresAt.getTime() - Date.now()) / 1000), 0);
    const accessCookie = [
      `access_token=${refreshed.token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');

    reply.header('x-access-token', refreshed.token);
    reply.header('x-access-token-expires-at', refreshed.expiresAt.toISOString());
    reply.header('Set-Cookie', accessCookie);

    return payload;
  });

  fastify.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    const statusCode = appError.statusCode;
    const logPayload: Record<string, unknown> = {
      err: error,
      traceId: request.id,
      method: request.method,
      url: request.url,
      statusCode,
    };
    if (appConfig.NODE_ENV === 'development') {
      logPayload.body = summarizeRequestBody(request.body);
    }
    request.log.error(logPayload, 'Request failed');
    if (error && typeof error === 'object' && 'code' in error) {
      const errCode = (error as any).code;
      const constraint = (error as any).constraint;
      request.log.warn({ code: errCode, constraint }, 'Database or runtime error code detected');
    }
    if (appError.code === 'CA_CERT_MISSING') {
      request.log.warn({ path: appConfig.CA_CERT_PATH }, 'CA certificate missing');
    }

    let clientError = appError;
    if (appConfig.NODE_ENV === 'development' && appError.code === 'INTERNAL_ERROR') {
      const message = error instanceof Error ? sanitizeErrorMessage(error.message) : '';
      if (message) {
        clientError = AppError.internal(`Internal error: ${message}`);
      }
    }

    reply.status(clientError.statusCode).send(formatErrorResponse(clientError, request.id));
  });

  fastify.setNotFoundHandler(() => {
    throw AppError.notFound('Route not found');
  });

  // Security middleware
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await fastify.register(fastifyCookie, {
    secret: appConfig.JWT_SECRET,
    hook: 'onRequest',
  });

  const allowedOrigins = [
    'http://localhost:8080',
    ...appConfig.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  ];

  // CORS
  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(new Error('CORS origin not allowed'), false);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS origin not allowed'), false);
    },
    credentials: true,
  });

  await fastify.register(csrfProtectionPlugin);

  // Rate limiting (can be disabled or tuned via env)
  if (appConfig.RATE_LIMIT_ENABLED) {
    await fastify.register(rateLimit, {
      max: appConfig.RATE_LIMIT_MAX,
      timeWindow: appConfig.RATE_LIMIT_TIME_WINDOW,
    });
  }

  // Swagger
  await fastify.register(swagger, {
    swagger: {
      info: {
        title: 'Hexmon Signage API',
        description: 'Production-ready digital signage CMS backend',
        version: '1.0.0',
      },
      host: `localhost:${appConfig.PORT}`,
      schemes: ['http', 'https'],
      consumes: ['application/json'],
      produces: ['application/json'],
      securityDefinitions: {
        bearerAuth: {
          type: 'apiKey',
          name: 'Authorization',
          in: 'header',
          description: 'Use: Bearer <JWT>',
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
  });

  // Health check
  fastify.get('/api/v1/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routes
  await fastify.register(authRoutes);
  await fastify.register(userRoutes);
  await fastify.register(departmentRoutes);
  await fastify.register(mediaRoutes);
  await fastify.register(scheduleRoutes);
  await fastify.register(screenRoutes);
  await fastify.register(auditLogRoutes);
  await fastify.register(requestRoutes);
  await fastify.register(emergencyRoutes);
  await fastify.register(notificationRoutes);
  await fastify.register(presentationRoutes);
  await fastify.register(devicePairingRoutes);
  await fastify.register(deviceTelemetryRoutes);
  await fastify.register(apiKeyRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(ssoConfigRoutes);
  await fastify.register(settingsRoutes);
  await fastify.register(conversationRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(proofOfPlayRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(reportsRoutes);
  await fastify.register(userInviteRoutes);
  await fastify.register(userActivateRoutes);
  await fastify.register(layoutRoutes);
  await fastify.register(screenGroupRoutes);
  await fastify.register(scheduleRequestRoutes);
  await fastify.register(roleRoutes);
  await fastify.register(permissionRoutes);

  return fastify;
}
