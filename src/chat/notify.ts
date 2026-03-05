import { createNotificationRepository } from '@/db/repositories/notification';
import { createLogger } from '@/utils/logger';

const logger = createLogger('chat-notify');

export type ChatNotificationType = 'DM' | 'MENTION' | 'THREAD_REPLY';

export type NotifyMessageEventInput = {
  conversation: {
    id: string;
    type: 'DM' | 'GROUP_CLOSED' | 'FORUM_OPEN';
    title?: string | null;
    participantA?: string | null;
    participantB?: string | null;
  };
  message: {
    id: string;
    body_text?: string | null;
  };
  senderId: string;
  mentionedUserIds?: string[];
  threadRootSenderId?: string | null;
};

function buildSnippet(text?: string | null, maxLength = 140): string {
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

export function computeNotificationRecipients(
  input: NotifyMessageEventInput
): Array<{ userId: string; type: ChatNotificationType }> {
  const recipients = new Map<string, ChatNotificationType>();

  if (input.conversation.type === 'DM') {
    const { participantA, participantB } = input.conversation;
    if (participantA && participantA !== input.senderId) recipients.set(participantA, 'DM');
    if (participantB && participantB !== input.senderId) recipients.set(participantB, 'DM');
  } else if (input.mentionedUserIds?.length) {
    for (const userId of input.mentionedUserIds) {
      if (userId !== input.senderId) recipients.set(userId, 'MENTION');
    }
  }

  if (
    input.threadRootSenderId &&
    input.threadRootSenderId !== input.senderId &&
    !recipients.has(input.threadRootSenderId)
  ) {
    recipients.set(input.threadRootSenderId, 'THREAD_REPLY');
  }

  return Array.from(recipients.entries()).map(([userId, type]) => ({ userId, type }));
}

export async function notifyMessageEvent(input: NotifyMessageEventInput): Promise<void> {
  const notificationRepo = createNotificationRepository();
  const recipients = computeNotificationRecipients(input);
  if (!recipients.length) return;

  const snippet = buildSnippet(input.message.body_text);
  const label = input.conversation.title || 'Conversation';

  try {
    await Promise.all(
      recipients.map(async ({ userId, type }) => {
        const title =
          type === 'DM' ? 'New direct message' : type === 'MENTION' ? 'You were mentioned' : 'New thread reply';

        const message =
          type === 'DM'
            ? `New message in your DM`
            : type === 'MENTION'
            ? `You were mentioned in ${label}`
            : `New reply in a thread in ${label}`;

        await notificationRepo.create({
          user_id: userId,
          title,
          message,
          type,
          data: {
            conversationId: input.conversation.id,
            messageId: input.message.id,
            notificationType: type,
            snippet,
          },
        });
      })
    );
  } catch (error) {
    logger.warn(error, 'Failed to create chat notifications');
  }
}
