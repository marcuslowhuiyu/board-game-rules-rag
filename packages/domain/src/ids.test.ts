import { describe, expect, it } from 'vitest';
import {
  ContentIdSchema,
  EditionIdSchema,
  GameIdSchema,
  MessageIdSchema,
  SessionIdSchema,
  SourceDocumentIdSchema,
  asGameId,
} from './ids.js';

describe('branded ids', () => {
  it('accepts valid ids across all id schemas', () => {
    expect(GameIdSchema.parse('game_1')).toBe('game_1');
    expect(EditionIdSchema.parse('ed-1')).toBe('ed-1');
    expect(ContentIdSchema.parse('c-a')).toBe('c-a');
    expect(SessionIdSchema.parse('s_1')).toBe('s_1');
    expect(MessageIdSchema.parse('m1')).toBe('m1');
    expect(SourceDocumentIdSchema.parse('doc_1')).toBe('doc_1');
  });

  it('rejects empty ids', () => {
    expect(GameIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects ids with unsafe characters', () => {
    for (const bad of ['a/b', 'a b', 'a;b', 'a#b', 'a?b', 'a.b']) {
      expect(GameIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects ids longer than 64 characters', () => {
    expect(GameIdSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('asGameId narrows the type at runtime', () => {
    const id = asGameId('t-i-4');
    expect(id).toBe('t-i-4');
  });
});
