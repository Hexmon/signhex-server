import Fastify from 'fastify';
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
import csrfProtectionPlugin from '@/middleware/csrf';
import { formatErrorResponse } from '@/utils/app-error';
import { toAppError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

export async function createServer() {
  const fastify = Fastify({
    logger: {
      level: appConfig.LOG_LEVEL,
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

  fastify.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    request.log.error({ err: error, traceId: request.id }, 'Request failed');
    reply.status(appError.statusCode).send(formatErrorResponse(appError, request.id));
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
  await fastify.register(proofOfPlayRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(reportsRoutes);
  await fastify.register(userInviteRoutes);
  await fastify.register(userActivateRoutes);
  await fastify.register(layoutRoutes);
  await fastify.register(screenGroupRoutes);
  await fastify.register(scheduleRequestRoutes);

  return fastify;
}
