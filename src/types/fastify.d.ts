import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    device?: {
      id: string;
      authType: 'device' | 'user';
      certificateId?: string;
      fingerprint?: string;
      authMethod?: 'legacy_serial' | 'signature';
      userId?: string;
    };
  }
}
