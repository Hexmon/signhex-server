import { FastifyRequest, FastifyReply } from 'fastify';
import { createAuditLogRepository } from '@/db/repositories/audit-log';
import { extractTokenFromHeader, verifyAccessToken } from '@/auth/jwt';
import { createLogger } from '@/utils/logger';

const logger = createLogger('audit-middleware');
const auditRepo = createAuditLogRepository();

export interface AuditContext {
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  changes?: Record<string, any>;
}

export async function logAudit(context: AuditContext, request: FastifyRequest) {
  try {
    // Extract user ID from token if available
    let userId = context.userId;
    if (!userId && request.headers.authorization) {
      try {
        const token = extractTokenFromHeader(request.headers.authorization);
        if (token) {
          const payload = await verifyAccessToken(token);
          userId = payload.sub;
        }
      } catch (error) {
        // Token verification failed, continue without user ID
      }
    }

    // Get IP address
    const ipAddress =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0] ||
      request.ip ||
      'unknown';

    // Get user agent
    const userAgent = (request.headers['user-agent'] as string) || 'unknown';

    // Log to database
    await auditRepo.create({
      user_id: userId || 'system',
      action: context.action,
      resource_type: context.resourceType,
      resource_id: context.resourceId,
      changes: context.changes,
      ip_address: ipAddress,
      user_agent: userAgent,
    });

    logger.info(
      {
        userId,
        action: context.action,
        resourceType: context.resourceType,
        resourceId: context.resourceId,
        ipAddress,
      },
      'Audit log created'
    );
  } catch (error) {
    logger.error(error, 'Failed to create audit log');
    // Don't throw - audit logging should not break the request
  }
}

export async function auditMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Store original send method
  const originalSend = reply.send.bind(reply);

  // Override send to capture response
  reply.send = function (payload: any) {
    // Attach audit context to request for later use
    if ((request as any).auditContext) {
      logAudit((request as any).auditContext, request).catch((error) => {
        logger.error(error, 'Audit logging error');
      });
    }

    return originalSend(payload);
  };
}

// Helper to attach audit context to request
export function attachAuditContext(
  request: FastifyRequest,
  context: AuditContext
) {
  (request as any).auditContext = context;
}

