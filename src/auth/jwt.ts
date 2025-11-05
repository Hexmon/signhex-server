import { SignJWT, jwtVerify, type JWTPayload as JoseJWTPayload } from 'jose';
import { getConfig } from '@/config';
import { randomUUID } from 'crypto';

export interface JWTPayload extends JoseJWTPayload {
  sub: string; // user ID
  email: string;
  role: string;
  jti: string; // JWT ID for revocation
  iat: number;
  exp: number;
}

export async function generateAccessToken(
  userId: string,
  email: string,
  role: string
): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const config = getConfig();
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + config.JWT_EXPIRY * 1000);

  const token = await new SignJWT({
    sub: userId,
    email,
    role,
    jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);

  return { token, jti, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const config = getConfig();
  const secret = new TextEncoder().encode(config.JWT_SECRET);

  try {
    const verified = await jwtVerify(token, secret);
    return verified.payload as JWTPayload;
  } catch (error) {
    throw new Error('Invalid or expired token');
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

