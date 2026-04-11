import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config as appConfig } from '@/config';
import { getObservabilityRegistry, observeHttpRequest } from '@/observability/metrics';

const REQUEST_START_KEY = Symbol.for('signhex.observability.request_start_ns');

type TimedRequest = FastifyRequest & {
  [REQUEST_START_KEY]?: bigint;
};

function isLoopbackIp(ip: string) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function hasBearerAccess(request: FastifyRequest) {
  const configuredToken = appConfig.OBSERVABILITY_METRICS_BEARER_TOKEN;
  if (!configuredToken) {
    return false;
  }

  const header = request.headers.authorization;
  if (!header) {
    return false;
  }

  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token === configuredToken;
}

function isMetricsRequestAllowed(request: FastifyRequest) {
  return isLoopbackIp(request.ip) || hasBearerAccess(request);
}

export async function registerObservabilityHttp(fastify: FastifyInstance) {
  fastify.addHook('onRequest', async (request) => {
    (request as TimedRequest)[REQUEST_START_KEY] = process.hrtime.bigint();
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const start = (request as TimedRequest)[REQUEST_START_KEY];
    if (!start) {
      return;
    }

    const durationSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    observeHttpRequest(request, reply, durationSeconds);
  });

  if (!appConfig.OBSERVABILITY_METRICS_ENABLED) {
    return;
  }

  fastify.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isMetricsRequestAllowed(request)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }

    const registry = getObservabilityRegistry();
    reply.header('content-type', registry.contentType);
    reply.send(await registry.metrics());
  });
}
