import type { Message, SessionId } from '@bgr/domain';

export interface MessagesRepository {
  appendMessage(message: Message): Promise<void>;
  listMessages(sessionId: SessionId): Promise<Message[]>;
}
