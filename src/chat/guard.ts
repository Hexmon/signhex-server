import { AppError } from '@/utils/app-error';

type ChatConversationState = 'ACTIVE' | 'ARCHIVED' | 'DELETED' | string;

type ConversationLike = {
  state: ChatConversationState;
};

export function assertConversationWritable(conversation: ConversationLike): void {
  if (conversation.state === 'ARCHIVED') {
    throw new AppError({
      statusCode: 409,
      code: 'CHAT_ARCHIVED',
      message: 'Conversation is archived and read-only',
      details: null,
    });
  }
}

