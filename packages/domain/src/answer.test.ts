import { describe, expect, it } from 'vitest';
import { AUTHORITIES } from './authority.js';
import { MessageSchema } from './message.js';
import { PANEL_TIERS, RulesAnswerSchema, panelTierOf } from './answer.js';

const confidence = { level: 'HIGH', reasons: ['DIRECTLY_STATED'] } as const;
const fullAnswer = {
  certainty: 'DEFINITIVE',
  authority: 'OFFICIAL_RULES',
  answer: 'Yes.',
  explanation: 'The rulebook says so.',
  evidence: [{ chunkId: 'c1' }],
  needsResearch: false,
  confidence,
  appliedTier: 'OFFICIAL',
  tiers: [
    {
      tier: 'OFFICIAL',
      answer: 'Yes.',
      certainty: 'DEFINITIVE',
      evidence: [{ chunkId: 'c1' }],
      confidence,
    },
  ],
  sourcesDisagree: false,
  requiresPlayerChoice: false,
};

describe('panelTierOf', () => {
  it('maps both official authorities to OFFICIAL', () => {
    expect(panelTierOf('OFFICIAL_RULES')).toBe('OFFICIAL');
    expect(panelTierOf('OFFICIAL_ERRATA')).toBe('OFFICIAL');
  });
  it('maps the other authorities one-to-one', () => {
    for (const a of AUTHORITIES.filter((x) => !x.startsWith('OFFICIAL'))) {
      expect(panelTierOf(a)).toBe(a);
    }
    expect(new Set(AUTHORITIES.map(panelTierOf))).toEqual(new Set(PANEL_TIERS));
  });
});

describe('RulesAnswerSchema', () => {
  it('accepts a full answer', () => {
    expect(RulesAnswerSchema.parse(fullAnswer)).toEqual(fullAnswer);
  });
  it('rejects an unknown certainty', () => {
    expect(RulesAnswerSchema.safeParse({ ...fullAnswer, certainty: 'MAYBE' }).success).toBe(false);
  });
});

describe('MessageSchema answer fields', () => {
  const base = {
    messageId: 'm1',
    sessionId: 's1',
    index: 0,
    role: 'ASSISTANT',
    content: 'hi',
    createdAt: '2026-10-30T00:00:00.000Z',
  };
  it('still parses a legacy message without answer', () => {
    expect(MessageSchema.safeParse(base).success).toBe(true);
  });
  it('parses a message with answer, models and promptVersions', () => {
    const r = MessageSchema.safeParse({
      ...base,
      answer: fullAnswer,
      models: { answerer: { key: 'gpt-6-luna', modelId: 'x' } },
      promptVersions: { answerer: 'answerer-v1' },
    });
    expect(r.success).toBe(true);
  });
});
