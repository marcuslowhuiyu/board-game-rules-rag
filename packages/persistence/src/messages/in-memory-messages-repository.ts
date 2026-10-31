import type { Message, SessionId } from '@bgr/domain';
import { MessageIndexTakenError, type MessagesRepository } from './messages-repository.js';

export class InMemoryMessagesRepository implements MessagesRepository {
  private readonly bySession = new Map<SessionId, Message[]>();

  async appendMessage(message: Message): Promise<void> {
    const existing = this.bySession.get(message.sessionId) ?? [];
    if (existing.some((m) => m.index === message.index)) {
      throw new MessageIndexTakenError(message.sessionId, message.index);
    }
    existing.push(message);
    existing.sort((a, b) => a.index - b.index);
    this.bySession.set(message.sessionId, existing);
  }

  // Always consistent: the options exist for stores with eventually consistent reads.
  async listMessages(sessionId: SessionId): Promise<Message[]> {
    return [...(this.bySession.get(sessionId) ?? [])];
  }
}
