import type { Session, SessionId } from '@bgr/domain';
import type { SessionsRepository } from './sessions-repository.js';

export class InMemorySessionsRepository implements SessionsRepository {
  private readonly sessions = new Map<SessionId, Session>();

  async createSession(session: Session): Promise<Session> {
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async getSession(sessionId: SessionId): Promise<Session | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.ttl * 1000 <= Date.now()) return null;
    return s;
  }

  async touch(
    sessionId: SessionId,
    updatedAt: string,
    expiresAt: string,
    ttl: number,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.set(sessionId, { ...s, updatedAt, expiresAt, ttl });
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
