import { hash, verify } from 'argon2';
import { AppError } from '@/utils/app-error';
import { getPasswordPolicy } from '@/utils/settings';

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
  const policy = getPasswordPolicy();

  if (password.length < policy.min_length) {
    throw AppError.validation([
      {
        field: 'password',
        message: `Password must be at least ${policy.min_length} characters long`,
      },
    ]);
  }

  const failures: string[] = [];
  if (policy.require_uppercase && !/[A-Z]/.test(password)) failures.push('uppercase');
  if (policy.require_lowercase && !/[a-z]/.test(password)) failures.push('lowercase');
  if (policy.require_number && !/\d/.test(password)) failures.push('number');
  if (policy.require_special && !/[^\w\s]/.test(password)) failures.push('special character');

  if (failures.length > 0) {
    throw AppError.validation([
      {
        field: 'password',
        message: `Password must include ${failures.join(', ')}`,
      },
    ]);
  }
}
