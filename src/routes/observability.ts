import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { apiEndpoints } from '@/config/apiEndpoints';
import { createLogger } from '@/utils/logger';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';
import {
  buildMachineSummaries,
  buildObservabilityOverviewSummary,
  buildScreenObservabilitySummary,
} from '@/observability/prometheus-summary';

const logger = createLogger('observability-routes');

async function requireAbility(request: FastifyRequest, subject: 'Dashboard' | 'Screen') {
  const token = extractTokenFromHeader(request.headers.authorization);
  if (!token) {
    throw AppError.unauthorized('Missing authorization header');
  }

  const payload = await verifyAccessToken(token);
  const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
  if (!ability.can('read', subject)) {
    throw AppError.forbidden('Forbidden');
  }
}

export async function observabilityRoutes(fastify: FastifyInstance) {
  fastify.get(
    apiEndpoints.observability.overview,
    {
      schema: {
        description: 'CMS-safe observability overview for dashboard cards and machine summaries.',
        tags: ['Observability'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAbility(request, 'Dashboard');
        return reply.send(await buildObservabilityOverviewSummary());
      } catch (error) {
        logger.error(error, 'Get observability overview error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get(
    apiEndpoints.observability.machines,
    {
      schema: {
        description: 'Machine-level observability summaries for CMS infrastructure views.',
        tags: ['Observability'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAbility(request, 'Dashboard');
        return reply.send({
          generated_at: new Date().toISOString(),
          machines: await buildMachineSummaries(),
        });
      } catch (error) {
        logger.error(error, 'Get observability machines error');
        return respondWithError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    apiEndpoints.observability.screen,
    {
      schema: {
        description: 'Per-screen observability summary for CMS current-state and Grafana drill-down.',
        tags: ['Observability'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await requireAbility(request, 'Screen');
        const summary = await buildScreenObservabilitySummary(request.params.id);
        if (!summary) {
          throw AppError.notFound('Screen not found');
        }
        return reply.send(summary);
      } catch (error) {
        logger.error(error, 'Get screen observability summary error');
        return respondWithError(reply, error);
      }
    }
  );
}
