import { describe, expect, it } from 'vitest';
import { toAppError } from '@/utils/errors';

describe('toAppError', () => {
  it('maps foreign key violations to conflict', () => {
    const appError = toAppError({
      code: '23503',
      constraint: 'chat_attachments_media_fk',
      message: 'update or delete on table "media" violates foreign key constraint',
    });

    expect(appError.statusCode).toBe(409);
    expect(appError.code).toBe('CONFLICT');
    expect(appError.message).toBe('Resource is still referenced and cannot be deleted.');
  });
});
