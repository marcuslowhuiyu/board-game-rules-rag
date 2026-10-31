import { ConflictError, type Message, type SessionId } from '@bgr/domain';

/** Another message already holds this (sessionId, index): re-read the session and retry. */
export class MessageIndexTakenError extends ConflictError {
  constructor(sessionId: SessionId, index: number) {
    super(`message index already taken: ${sessionId}#${index}`);
    this.name = 'MessageIndexTakenError';
  }
}

export interface ListMessagesOptions {
  /** Read the latest writes (a strongly consistent read where the store supports it). */
  consistentRead?: boolean;
}

export interface MessagesRepository {
  /** Store a message; throws MessageIndexTakenError if its index is taken. Never overwrites. */
  appendMessage(message: Message): Promise<void>;
  listMessages(sessionId: SessionId, options?: ListMessagesOptions): Promise<Message[]>;
}
