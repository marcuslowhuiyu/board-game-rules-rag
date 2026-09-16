import type { Message, SessionId } from '@bgr/domain';
import type { MessagesRepository } from './messages-repository.js';

export class InMemoryMessagesRepository implements MessagesRepository {
  private readonly bySession = new Map<SessionId, Message[]>();

  async appendMessage(message: Message): Promise<void> {
    const existing = this.bySession.get(message.sessionId) ?? [];
    existing.push(message);
    existing.sort((a, b) => a.index - b.index);
    this.bySession.set(message.sessionId, existing);
  }

  async listMessages(sessionId: SessionId): Promise<Message[]> {
    return [...(this.bySession.get(sessionId) ?? [])];
  }
}
