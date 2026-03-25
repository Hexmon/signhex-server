import { SignJWT, jwtVerify, type JWTPayload as JoseJWTPayload } from 'jose';
import { config as appConfig } from '@/config';
import { randomUUID } from 'crypto';
import { AuthError } from '@/auth/errors';

export interface JWTPayload extends JoseJWTPayload {
  sub: string; // user ID
  email: string;
  role_id: string;
  role: string;
  department_id?: string;
  jti: string; // JWT ID for revocation
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();
const secret = encoder.encode(appConfig.JWT_SECRET);

export async function generateAccessToken(
  userId: string,
  email: string,
  roleId: string,
  roleName: string,
  departmentId?: string | null
): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + appConfig.JWT_EXPIRY * 1000);

  const token = await new SignJWT({
    sub: userId,
    email,
    role_id: roleId,
    role: roleName,
    department_id: departmentId ?? undefined,
    jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);

  return { token, jti, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const secret = new TextEncoder().encode(appConfig.JWT_SECRET);

  try {
    const verified = await jwtVerify(token, secret);
    return verified.payload as JWTPayload;
  } catch (error) {
    throw new AuthError('Invalid or expired token');
  }
}

export function extractTokenFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}
