import { randomBytes, randomUUID } from 'node:crypto';

export interface IdGenerator {
  gameId(): string;
  editionId(): string;
  contentId(): string;
  sessionId(): string;
  messageId(): string;
}

const short = (): string => randomUUID().replace(/-/g, '').slice(0, 16);

export const cryptoIdGenerator: IdGenerator = {
  gameId: () => `g_${short()}`,
  editionId: () => `e_${short()}`,
  contentId: () => `c_${short()}`,
  sessionId: () => `s_${randomBytes(24).toString('base64url')}`,
  messageId: () => `m_${short()}`,
};

export const staticIdGenerator = (values: {
  gameId?: string;
  editionId?: string;
  contentId?: string;
  sessionId?: string;
  messageId?: string;
}): IdGenerator => ({
  gameId: () => values.gameId ?? 'g_static',
  editionId: () => values.editionId ?? 'e_static',
  contentId: () => values.contentId ?? 'c_static',
  sessionId: () => values.sessionId ?? 's_static',
  messageId: () => values.messageId ?? 'm_static',
});
