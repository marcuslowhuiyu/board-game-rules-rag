import { describe, expect, it } from 'vitest';
import {
  asContentId,
  asEditionId,
  asGameId,
  asSessionId,
  configurationFingerprint,
  type Session,
} from '@bgr/domain';
import { InMemorySessionsRepository } from './in-memory-sessions-repository.js';

const iso = '2026-09-16T00:00:00.000Z';

const makeSession = (over: Partial<Session> = {}): Session => ({
  sessionId: asSessionId('s_abc'),
  gameId: asGameId('g_ti4'),
  editionId: asEditionId('e_1'),
  enabledContentIds: [asContentId('c_pok')],
  configurationFingerprint: configurationFingerprint(asGameId('g_ti4'), asEditionId('e_1'), [
    asContentId('c_pok'),
  ]),
  createdAt: iso,
  updatedAt: iso,
  expiresAt: '2099-01-01T00:00:00.000Z',
  ttl: Math.floor(new Date('2099-01-01T00:00:00.000Z').getTime() / 1000),
  ...over,
});

describe('InMemorySessionsRepository', () => {
  it('creates and reads a session', async () => {
    const repo = new InMemorySessionsRepository();
    const s = makeSession();
    await repo.createSession(s);
    expect(await repo.getSession(s.sessionId)).toEqual(s);
  });

  it('returns null after delete', async () => {
    const repo = new InMemorySessionsRepository();
    const s = makeSession();
    await repo.createSession(s);
    await repo.deleteSession(s.sessionId);
    expect(await repo.getSession(s.sessionId)).toBeNull();
  });

  it('touch updates expiresAt and ttl', async () => {
    const repo = new InMemorySessionsRepository();
    const s = makeSession();
    await repo.createSession(s);
    await repo.touch(s.sessionId, iso, '2100-01-01T00:00:00.000Z', 4_102_444_800);
    const got = await repo.getSession(s.sessionId);
    expect(got?.expiresAt).toBe('2100-01-01T00:00:00.000Z');
  });

  it('treats an expired session as absent', async () => {
    const repo = new InMemorySessionsRepository();
    const s = makeSession({ ttl: 1 });
    await repo.createSession(s);
    expect(await repo.getSession(s.sessionId)).toBeNull();
  });
});
