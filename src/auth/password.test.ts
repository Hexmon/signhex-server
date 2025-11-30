import { describe, it, expect } from 'vitest';
import { validatePasswordStrength } from './password';

describe('password strength', () => {
  it('accepts strong passwords', () => {
    expect(() => validatePasswordStrength('Str0ng!Password123')).not.toThrow();
  });

  it('rejects weak passwords', () => {
    expect(() => validatePasswordStrength('weakpass')).toThrow();
    expect(() => validatePasswordStrength('NoNumber!')).toThrow();
    expect(() => validatePasswordStrength('nonumberspecial')).toThrow();
  });
});
