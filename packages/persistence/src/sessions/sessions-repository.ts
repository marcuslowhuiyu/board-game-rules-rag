import type { Session, SessionId } from '@bgr/domain';

export interface SessionsRepository {
  createSession(session: Session): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  /** Refresh expiresAt/ttl/updatedAt to the new activity time. */
  touch(sessionId: SessionId, updatedAt: string, expiresAt: string, ttl: number): Promise<void>;
  deleteSession(sessionId: SessionId): Promise<void>;
}
