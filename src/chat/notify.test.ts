import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeNotificationRecipients, notifyMessageEvent } from '@/chat/notify';

const createMock = vi.fn();

vi.mock('@/db/repositories/notification', () => ({
  createNotificationRepository: () => ({
    create: createMock,
  }),
}));

describe('computeNotificationRecipients', () => {
  it('creates DM notification for the other participant only', () => {
    const recipients = computeNotificationRecipients({
      conversation: {
        id: 'conv-1',
        type: 'DM',
        participantA: 'user-a',
        participantB: 'user-b',
      },
      message: { id: 'm1', body_text: 'hello' },
      senderId: 'user-a',
    });

    expect(recipients).toEqual([{ userId: 'user-b', type: 'DM' }]);
  });

  it('creates mention notifications and excludes sender', () => {
    const recipients = computeNotificationRecipients({
      conversation: {
        id: 'conv-2',
        type: 'GROUP_CLOSED',
      },
      message: { id: 'm2', body_text: 'hi' },
      senderId: 'user-a',
      mentionedUserIds: ['user-a', 'user-b', 'user-c'],
    });

    expect(recipients).toEqual([
      { userId: 'user-b', type: 'MENTION' },
      { userId: 'user-c', type: 'MENTION' },
    ]);
  });

  it('adds thread reply notification for root sender when different', () => {
    const recipients = computeNotificationRecipients({
      conversation: {
        id: 'conv-3',
        type: 'GROUP_CLOSED',
      },
      message: { id: 'm3', body_text: 'reply' },
      senderId: 'user-a',
      mentionedUserIds: ['user-b'],
      threadRootSenderId: 'user-c',
    });

    expect(recipients).toEqual([
      { userId: 'user-b', type: 'MENTION' },
      { userId: 'user-c', type: 'THREAD_REPLY' },
    ]);
  });
});

describe('notifyMessageEvent', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('does not throw when notification persistence fails', async () => {
    createMock.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(
      notifyMessageEvent({
        conversation: {
          id: 'conv-dm',
          type: 'DM',
          participantA: 'user-a',
          participantB: 'user-b',
        },
        message: { id: 'msg-1', body_text: 'hello' },
        senderId: 'user-a',
      })
    ).resolves.toBeUndefined();
  });
});
