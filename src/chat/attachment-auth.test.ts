import { describe, it, expect } from 'vitest';
import { assertAttachmentAccess } from '@/chat/attachment-auth';

describe('assertAttachmentAccess', () => {
  it('rejects non-owner non-admin attaching another user media', () => {
    expect(() =>
      assertAttachmentAccess({
        requestedMediaIds: ['m1'],
        mediaRows: [{ id: 'm1', created_by: 'user-b' }],
        senderId: 'user-a',
        senderRole: 'USER',
        senderDepartmentId: 'dep-1',
        canOverrideMedia: false,
      })
    ).toThrow('You cannot attach this media');
  });

  it('allows admin attaching another user media', () => {
    expect(() =>
      assertAttachmentAccess({
        requestedMediaIds: ['m1'],
        mediaRows: [{ id: 'm1', created_by: 'user-b' }],
        senderId: 'admin-1',
        senderRole: 'ADMIN',
        senderDepartmentId: 'dep-1',
        canOverrideMedia: false,
      })
    ).not.toThrow();
  });

  it('fails atomically when one attachment is invalid/missing', () => {
    expect(() =>
      assertAttachmentAccess({
        requestedMediaIds: ['m1', 'm2'],
        mediaRows: [{ id: 'm1', created_by: 'user-a' }],
        senderId: 'user-a',
        senderRole: 'USER',
        senderDepartmentId: 'dep-1',
        canOverrideMedia: false,
      })
    ).toThrow('One or more attachments are invalid');
  });
});

