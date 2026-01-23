import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, gte, lte, eq, isNull, isNotNull, sql, inArray } from 'drizzle-orm';
import { getDatabase, schema } from '@/db';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { createLogger } from '@/utils/logger';
import { stringify } from 'csv-stringify/sync';
import { getPresignedUrl } from '@/s3';
import { apiEndpoints } from '@/config/apiEndpoints';
import { HTTP_STATUS } from '@/http-status-codes';
import { respondWithError } from '@/utils/errors';
import { AppError } from '@/utils/app-error';

const logger = createLogger('proof-of-play-routes');
const { BAD_REQUEST, FORBIDDEN, UNAUTHORIZED } = HTTP_STATUS;

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  screen_id: z.string().uuid().optional(),
  media_id: z.string().uuid().optional(),
  schedule_id: z.string().uuid().optional(),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
  status: z.enum(['COMPLETED', 'INCOMPLETE']).optional(),
  include_url: z.enum(['true', 'false']).optional(),
  group_by: z.enum(['day', 'screen', 'media']).optional(),
});

export async function proofOfPlayRoutes(fastify: FastifyInstance) {
  const db = getDatabase();
  const buildConditions = (query: typeof listSchema._type) => {
    const conditions: any[] = [];
    if (query.screen_id) conditions.push(eq(schema.proofOfPlay.screen_id, query.screen_id));
    if (query.media_id) conditions.push(eq(schema.proofOfPlay.media_id, query.media_id));
    if (query.schedule_id) conditions.push(eq(schema.proofOfPlay.presentation_id, query.schedule_id));
    if (query.start) conditions.push(gte(schema.proofOfPlay.created_at, new Date(query.start)));
    if (query.end) conditions.push(lte(schema.proofOfPlay.created_at, new Date(query.end)));
    if (query.status === 'COMPLETED') conditions.push(isNotNull(schema.proofOfPlay.ended_at));
    if (query.status === 'INCOMPLETE') conditions.push(isNull(schema.proofOfPlay.ended_at));
    return conditions;
  };

  fastify.get<{ Querystring: typeof listSchema._type }>(
    apiEndpoints.proofOfPlay.list,
    {
      schema: {
        description: 'List proof-of-play records',
        tags: ['Proof of Play'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ProofOfPlay')) throw AppError.forbidden('Forbidden');

        const query = listSchema.parse(request.query);
        const page = query.page;
        const limit = query.limit;
        const offset = (page - 1) * limit;

        const conditions = buildConditions(query);
        const where = conditions.length ? and(...conditions) : undefined;

        // Grouping mode for charts
        if (query.group_by) {
          if (query.group_by === 'day') {
            const grouped = await db
              .select({
                day: sql<string>`date(${schema.proofOfPlay.created_at})`,
                count: sql<number>`count(*)`,
              })
              .from(schema.proofOfPlay)
              .where(where as any)
              .groupBy(sql`date(${schema.proofOfPlay.created_at})`)
              .orderBy(sql`date(${schema.proofOfPlay.created_at})`);
            return reply.send({ items: grouped, pagination: null });
          }
          if (query.group_by === 'screen') {
            const grouped = await db
              .select({
                screen_id: schema.proofOfPlay.screen_id,
                count: sql<number>`count(*)`,
              })
              .from(schema.proofOfPlay)
              .where(where as any)
              .groupBy(schema.proofOfPlay.screen_id);
            return reply.send({ items: grouped, pagination: null });
          }
          if (query.group_by === 'media') {
            const grouped = await db
              .select({
                media_id: schema.proofOfPlay.media_id,
                count: sql<number>`count(*)`,
              })
              .from(schema.proofOfPlay)
              .where(where as any)
              .groupBy(schema.proofOfPlay.media_id);
            return reply.send({ items: grouped, pagination: null });
          }
        }

        const items = await db
          .select()
          .from(schema.proofOfPlay)
          .where(where as any)
          .orderBy(desc(schema.proofOfPlay.created_at))
          .limit(limit)
          .offset(offset);

        const total = await db.select().from(schema.proofOfPlay).where(where as any);

        let enriched = items;
        if (query.include_url === 'true') {
          const storageIds = items.map((i) => i.storage_object_id).filter(Boolean) as string[];
          const storageRows = storageIds.length
            ? await db
              .select()
              .from(schema.storageObjects)
              .where(inArray(schema.storageObjects.id, storageIds))
            : [];
          const storageMap = new Map(storageRows.map((s) => [s.id, s]));
          enriched = await Promise.all(
            items.map(async (i) => {
              const storage = i.storage_object_id ? storageMap.get(i.storage_object_id) : null;
              const url = storage ? await getPresignedUrl(storage.bucket, storage.object_key, 3600) : null;
              return { ...i, url };
            })
          );
        }

        return reply.send({
          items: enriched,
          pagination: { page, limit, total: total.length },
        });
      } catch (error) {
        logger.error(error, 'List proof-of-play error');
        return respondWithError(reply, error);
      }
    }
  );

  // Export CSV
  fastify.get<{ Querystring: typeof listSchema._type }>(
    apiEndpoints.proofOfPlay.export,
    {
      schema: {
        description: 'Export proof-of-play records as CSV',
        tags: ['Proof of Play'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) throw AppError.unauthorized('Missing authorization header');
        const payload = await verifyAccessToken(token);
        const ability = await defineAbilityFor(payload.role_id, payload.sub, payload.department_id);
        if (!ability.can('read', 'ProofOfPlay')) throw AppError.forbidden('Forbidden');

        const query = listSchema.parse(request.query);
        const where = (buildConditions(query).length ? and(...buildConditions(query)) : undefined) as any;
        const items = await db
          .select()
          .from(schema.proofOfPlay)
          .where(where)
          .orderBy(desc(schema.proofOfPlay.created_at));

        const csv = stringify(
          items.map((i) => ({
            id: i.id,
            screen_id: i.screen_id,
            media_id: i.media_id,
            presentation_id: i.presentation_id,
            started_at: i.started_at?.toISOString?.() ?? i.started_at,
            ended_at: i.ended_at?.toISOString?.() ?? i.ended_at,
            created_at: i.created_at?.toISOString?.() ?? i.created_at,
          })),
          { header: true }
        );

        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', 'attachment; filename="proof-of-play.csv"');
        return reply.send(csv);
      } catch (error) {
        logger.error(error, 'Export proof-of-play error');
        return respondWithError(reply, error);
      }
    }
  );
}
