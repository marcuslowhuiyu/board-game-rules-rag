import { randomBytes, randomUUID } from 'node:crypto';

export interface IdGenerator {
  gameId(): string;
  editionId(): string;
  contentId(): string;
  sessionId(): string;
  messageId(): string;
  sourceDocumentId(): string;
  chunkId(): string;
  ingestionJobId(): string;
}

const short = (): string => randomUUID().replace(/-/g, '').slice(0, 16);

export const cryptoIdGenerator: IdGenerator = {
  gameId: () => `g_${short()}`,
  editionId: () => `e_${short()}`,
  contentId: () => `c_${short()}`,
  sessionId: () => `s_${randomBytes(24).toString('base64url')}`,
  messageId: () => `m_${short()}`,
  sourceDocumentId: () => `doc_${short()}`,
  chunkId: () => `ch_${short()}`,
  ingestionJobId: () => `job_${short()}`,
};

export const staticIdGenerator = (values: {
  gameId?: string;
  editionId?: string;
  contentId?: string;
  sessionId?: string;
  messageId?: string;
  sourceDocumentId?: string;
  chunkId?: string;
  ingestionJobId?: string;
}): IdGenerator => ({
  gameId: () => values.gameId ?? 'g_static',
  editionId: () => values.editionId ?? 'e_static',
  contentId: () => values.contentId ?? 'c_static',
  sessionId: () => values.sessionId ?? 's_static',
  messageId: () => values.messageId ?? 'm_static',
  sourceDocumentId: () => values.sourceDocumentId ?? 'doc_static',
  chunkId: () => values.chunkId ?? 'ch_static',
  ingestionJobId: () => values.ingestionJobId ?? 'job_static',
});
