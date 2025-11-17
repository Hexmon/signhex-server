import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config as appConfig } from '@/config';
// import { createLogger } from '@/utils/logger';
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

// const logger = createLogger('server');

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
  });

  // CORS
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  // Rate limiting
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '15 minutes',
  });

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
  fastify.get('/health', async () => {
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

  return fastify;
}

