import { hash, verify } from 'argon2';
import { config as appConfig } from '@/config';

const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).+$/;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    type: 2, // argon2id
    memoryCost: 19 * 1024, // 19 MB
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await verify(hash, password);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(password: string): void {
  if (password.length < appConfig.PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${appConfig.PASSWORD_MIN_LENGTH} characters long`);
  }
  if (!PASSWORD_COMPLEXITY_REGEX.test(password)) {
    throw new Error('Password must include upper, lower, number, and special character');
  }
}
