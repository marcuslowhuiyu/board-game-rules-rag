import type { RulesAnswer } from '@bgr/domain';
import type { RetrievedChunk } from '@bgr/retrieval';
import { describe, expect, it } from 'vitest';
import type { AnswerCase } from '../dataset/answer-case-schema.js';
import { scoreAnswerCase } from './score-answer.js';

const chunk = (chunkId: string, text: string): RetrievedChunk => ({
  chunkId,
  documentId: 'd',
  gameId: 'g',
  editionId: 'e',
  contentId: 'c',
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  headingPath: ['Rules'],
  pageStart: 1,
  pageEnd: 1,
  text,
  score: 0.5,
});

const answer = (over: Partial<RulesAnswer> = {}): RulesAnswer => ({
  certainty: 'DEFINITIVE',
  authority: 'OFFICIAL_RULES',
  answer: 'Draw two cards.',
  explanation: 'See the setup rule.',
  evidence: [{ chunkId: 'c1' }],
  needsResearch: false,
  confidence: { level: 'HIGH', reasons: ['DIRECTLY_STATED'] },
  appliedTier: 'OFFICIAL',
  tiers: [],
  sourcesDisagree: false,
  requiresPlayerChoice: false,
  ...over,
});

const answerable = (over: Record<string, unknown> = {}): AnswerCase => ({
  kind: 'answerable',
  case: {
    id: 'a1',
    game: 'g',
    edition: 'e',
    enabledContent: ['base'],
    tier: 'simple',
    question: 'How many cards?',
    requiredEvidence: [{ key: 'k', phrase: 'draw two cards', required: true }],
    source: { url: 'https://example.com', title: 't' },
    answer: { certainty: 'DEFINITIVE', ...over },
  },
});

const notInRulebook = (): AnswerCase => ({
  kind: 'not-in-rulebook',
  case: {
    id: 'n1',
    game: 'g',
    edition: 'e',
    enabledContent: ['base'],
    tier: 'simple',
    question: 'Unknown?',
    source: { url: 'https://example.com', title: 't' },
    answer: { certainty: 'INCONCLUSIVE' },
  },
});

const passages = [
  chunk('c1', 'Each player may Draw two cards at setup.'),
  chunk('c2', 'Other text'),
];
const run = (a: RulesAnswer, tier: 'simple' | 'complex' = 'simple') => ({
  answer: a,
  passages,
  tier,
});

describe('scoreAnswerCase', () => {
  it('a tier panel ruling on a not-in-rulebook case is a guess, even under an INCONCLUSIVE answer', () => {
    // The player sees the panel's ruling, so it counts like a top-level one.
    const inconclusive = answer({
      certainty: 'INCONCLUSIVE',
      authority: 'UNKNOWN',
      evidence: [],
      appliedTier: null,
      tiers: [
        {
          tier: 'OFFICIAL',
          answer: 'Yes, you may.',
          certainty: 'DEFINITIVE',
          evidence: [{ chunkId: 'c2' }],
          confidence: { level: 'HIGH', reasons: ['DIRECTLY_STATED'] },
        },
      ],
    });
    expect(scoreAnswerCase(notInRulebook(), run(inconclusive))).toMatchObject({
      guess: true,
      certaintyOk: true,
    });
  });

  it('correct definitive answer with cited evidence scores right', () => {
    const s = scoreAnswerCase(answerable({ authority: 'OFFICIAL_RULES' }), run(answer()));
    expect(s).toMatchObject({
      certaintyOk: true,
      guess: false,
      evidenceOk: true,
      authorityOk: true,
      forbiddenHit: null,
      disagreeOk: null,
      playerChoiceOk: null,
      confidence: 'HIGH',
      routedTier: 'simple',
      labelledTier: 'simple',
    });
  });

  it('QUALIFIED where DEFINITIVE expected is a certainty miss, not a guess', () => {
    const s = scoreAnswerCase(answerable(), run(answer({ certainty: 'QUALIFIED' })));
    expect(s.certaintyOk).toBe(false);
    expect(s.guess).toBe(false);
  });

  it('not-in-rulebook answered DEFINITIVE is a guess', () => {
    const s = scoreAnswerCase(notInRulebook(), run(answer()));
    expect(s.guess).toBe(true);
    expect(s.certaintyOk).toBe(false);
    expect(s.evidenceOk).toBeNull();
    const ok = scoreAnswerCase(notInRulebook(), run(answer({ certainty: 'INCONCLUSIVE' })));
    expect(ok.guess).toBe(false);
    expect(ok.certaintyOk).toBe(true);
  });

  it('evidence cited only in a panel does not satisfy required evidence', () => {
    const a = answer({
      evidence: [{ chunkId: 'c2' }],
      tiers: [
        {
          tier: 'OFFICIAL',
          answer: 'x',
          certainty: 'DEFINITIVE',
          evidence: [{ chunkId: 'c1' }],
          confidence: { level: 'HIGH', reasons: [] },
        },
      ],
    });
    expect(scoreAnswerCase(answerable(), run(a)).evidenceOk).toBe(false);
  });

  it('uncited retrieved passage does not satisfy required evidence', () => {
    const a = answer({ evidence: [] });
    expect(scoreAnswerCase(answerable(), run(a)).evidenceOk).toBe(false);
  });

  it('forbidden claim in a panel answer fails', () => {
    const a = answer({
      tiers: [
        {
          tier: 'COMMUNITY_DISCUSSION',
          answer: 'Players may DRAW  “Three”—cards.',
          certainty: 'QUALIFIED',
          evidence: [],
          confidence: { level: 'LOW', reasons: [] },
        },
      ],
    });
    const s = scoreAnswerCase(answerable({ forbiddenClaims: ['draw "three"-cards'] }), run(a));
    expect(s.forbiddenHit).toBe('draw "three"-cards');
  });

  it('forbidden claim in the applied answer or explanation fails', () => {
    const s = scoreAnswerCase(answerable({ forbiddenClaims: ['see the setup'] }), run(answer()));
    expect(s.forbiddenHit).toBe('see the setup');
  });

  it('checks authority, disagreement and player choice when set', () => {
    const s = scoreAnswerCase(
      answerable({
        authority: 'OFFICIAL_ERRATA',
        sourcesDisagree: true,
        requiresPlayerChoice: true,
      }),
      run(answer({ sourcesDisagree: true })),
    );
    expect(s).toMatchObject({ authorityOk: false, disagreeOk: true, playerChoiceOk: false });
  });

  it('a pipeline error is reported and never passes', () => {
    const s = scoreAnswerCase(answerable({ authority: 'OFFICIAL_RULES' }), { error: 'boom' });
    expect(s).toMatchObject({
      error: 'boom',
      certaintyOk: false,
      guess: false,
      evidenceOk: false,
      authorityOk: false,
      confidence: null,
      routedTier: null,
    });
    expect(scoreAnswerCase(notInRulebook(), { error: 'boom' }).evidenceOk).toBeNull();
  });
});
