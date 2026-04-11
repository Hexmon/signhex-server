import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { apiEndpoints } from '@/config/apiEndpoints';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import { logAudit } from '@/middleware/audit';
import { createLogger } from '@/utils/logger';

const logger = createLogger('security-event-routes');

const clientEventSchema = z.object({
  event: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[A-Z0-9_:-]+$/, 'Event must be an uppercase identifier'),
  context: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export async function securityEventRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: z.infer<typeof clientEventSchema> }>(
    apiEndpoints.security.clientEvents,
    {
      schema: {
        description: 'Record authenticated client-side security telemetry events',
        tags: ['Security'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Body: z.infer<typeof clientEventSchema> }>, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          throw AppError.unauthorized('Missing authorization header');
        }

        const payload = await verifyAccessToken(token);
        const body = clientEventSchema.parse(request.body);

        await logAudit(
          {
            userId: payload.sub,
            action: body.event,
            resourceType: 'SECURITY_EVENT',
            resourceId: request.id,
            changes: {
              ...body.context,
              source: 'CMS',
              route: typeof body.context?.route === 'string' ? body.context.route : null,
              trigger: typeof body.context?.trigger === 'string' ? body.context.trigger : null,
              detected_at:
                typeof body.context?.detected_at === 'string' ? body.context.detected_at : new Date().toISOString(),
            },
          },
          request
        );

        return reply.status(204).send();
      } catch (error) {
        logger.error(error, 'Client security event error');
        return respondWithError(reply, error);
      }
    }
  );
}
