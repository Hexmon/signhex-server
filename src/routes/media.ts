import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createMediaSchema, presignUploadSchema, listMediaQuerySchema } from '@/schemas/media';
import { createMediaRepository } from '@/db/repositories/media';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { defineAbilityFor } from '@/rbac';
import { getPresignedPutUrl, createBucketIfNotExists } from '@/s3';
import { createLogger } from '@/utils/logger';
import { randomUUID } from 'crypto';

const logger = createLogger('media-routes');

export async function mediaRoutes(fastify: FastifyInstance) {
  const mediaRepo = createMediaRepository();

  // Presign upload URL
  fastify.post<{ Body: typeof presignUploadSchema._type }>(
    '/v1/media/presign-upload',
    {
      schema: {
        description: 'Get presigned URL for direct media upload to MinIO',
        tags: ['Media'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'Media')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = presignUploadSchema.parse(request.body);
        const mediaId = randomUUID();
        const objectKey = `${mediaId}/${data.filename}`;

        // Ensure bucket exists
        await createBucketIfNotExists('media-source');

        // Generate presigned URL
        const uploadUrl = await getPresignedPutUrl('media-source', objectKey, 3600);

        // Create media record
        const media = await mediaRepo.create({
          name: data.filename,
          type: 'IMAGE', // Default, should be determined by content type
          created_by: payload.sub,
        });

        return reply.send({
          upload_url: uploadUrl,
          media_id: media.id,
          expires_in: 3600,
        });
      } catch (error) {
        logger.error(error, 'Presign upload error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Create media metadata
  fastify.post<{ Body: typeof createMediaSchema._type }>(
    '/v1/media',
    {
      schema: {
        description: 'Create media metadata',
        tags: ['Media'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        const payload = await verifyAccessToken(token);
        const ability = defineAbilityFor(payload.role as any, payload.sub);

        if (!ability.can('create', 'Media')) {
          return reply.status(403).send({ error: 'Forbidden' });
        }

        const data = createMediaSchema.parse(request.body);
        const media = await mediaRepo.create({
          name: data.name,
          type: data.type,
          created_by: payload.sub,
        });

        return reply.status(201).send({
          id: media.id,
          name: media.name,
          type: media.type,
          status: media.status,
          created_by: media.created_by,
          created_at: media.created_at.toISOString(),
          updated_at: media.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Create media error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // List media
  fastify.get<{ Querystring: typeof listMediaQuerySchema._type }>(
    '/v1/media',
    {
      schema: {
        description: 'List media with pagination and filtering',
        tags: ['Media'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const query = listMediaQuerySchema.parse(request.query);
        const result = await mediaRepo.list({
          page: query.page,
          limit: query.limit,
          type: query.type,
          status: query.status,
        });

        return reply.send({
          items: result.items.map((m) => ({
            id: m.id,
            name: m.name,
            type: m.type,
            status: m.status,
            duration_seconds: m.duration_seconds,
            width: m.width,
            height: m.height,
            created_by: m.created_by,
            created_at: m.created_at.toISOString(),
            updated_at: m.updated_at.toISOString(),
          })),
          pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
          },
        });
      } catch (error) {
        logger.error(error, 'List media error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );

  // Get media by ID
  fastify.get<{ Params: { id: string } }>(
    '/v1/media/:id',
    {
      schema: {
        description: 'Get media by ID',
        tags: ['Media'],
        security: [{ bearerAuth: [] }],
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (!token) {
          return reply.status(401).send({ error: 'Missing authorization header' });
        }

        await verifyAccessToken(token);

        const media = await mediaRepo.findById((request.params as any).id);
        if (!media) {
          return reply.status(404).send({ error: 'Media not found' });
        }

        return reply.send({
          id: media.id,
          name: media.name,
          type: media.type,
          status: media.status,
          duration_seconds: media.duration_seconds,
          width: media.width,
          height: media.height,
          created_by: media.created_by,
          created_at: media.created_at.toISOString(),
          updated_at: media.updated_at.toISOString(),
        });
      } catch (error) {
        logger.error(error, 'Get media error');
        return reply.status(400).send({ error: 'Invalid request' });
      }
    }
  );
}

