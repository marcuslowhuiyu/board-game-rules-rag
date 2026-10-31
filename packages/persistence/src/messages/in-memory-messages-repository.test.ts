import { describe, expect, it } from 'vitest';
import { asMessageId, asSessionId, type Message } from '@bgr/domain';
import { InMemoryMessagesRepository } from './in-memory-messages-repository.js';
import { MessageIndexTakenError } from './messages-repository.js';

const iso = '2026-09-16T00:00:00.000Z';
const sessionId = asSessionId('s_abc');

const msg = (index: number, role: 'USER' | 'ASSISTANT'): Message => ({
  messageId: asMessageId(`m_${index}`),
  sessionId,
  index,
  role,
  content: `content-${index}`,
  createdAt: iso,
});

describe('InMemoryMessagesRepository', () => {
  it('appends and returns messages in index order', async () => {
    const repo = new InMemoryMessagesRepository();
    await repo.appendMessage(msg(2, 'ASSISTANT'));
    await repo.appendMessage(msg(0, 'USER'));
    await repo.appendMessage(msg(1, 'USER'));
    const list = await repo.listMessages(sessionId);
    expect(list.map((m) => m.index)).toEqual([0, 1, 2]);
  });
});

describe('InMemoryMessagesRepository index collisions', () => {
  it('rejects a second message at a taken index and keeps the first', async () => {
    const repo = new InMemoryMessagesRepository();
    await repo.appendMessage(msg(0, 'USER'));
    const clash = { ...msg(0, 'ASSISTANT'), messageId: asMessageId('m_other') };
    await expect(repo.appendMessage(clash)).rejects.toBeInstanceOf(MessageIndexTakenError);
    const list = await repo.listMessages(sessionId);
    expect(list.map((m) => m.messageId)).toEqual(['m_0']);
  });

  it('allows the same index in different sessions', async () => {
    const repo = new InMemoryMessagesRepository();
    await repo.appendMessage(msg(0, 'USER'));
    await repo.appendMessage({ ...msg(0, 'USER'), sessionId: asSessionId('s_other') });
    expect(await repo.listMessages(asSessionId('s_other'))).toHaveLength(1);
  });
});
