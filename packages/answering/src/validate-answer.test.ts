import type { ModelAnswer } from '@bgr/ai';
import {
  RulesAnswerSchema,
  type Authority,
  type ProvenanceEvidence,
  type RulesAnswer,
} from '@bgr/domain';
import { describe, expect, it } from 'vitest';
import { inconclusiveAnswer, validateAnswer, type CitedSource } from './validate-answer.js';

const attested = (authority: Authority): ProvenanceEvidence => ({
  kind: 'OPERATOR_ATTESTED',
  authority,
  recordedAt: '2026-10-30T00:00:00.000Z',
});

const src = (
  chunkId: string,
  authority: Authority,
  provenance: readonly ProvenanceEvidence[] = [attested(authority)],
): CitedSource => ({ chunkId, authority, provenance });

// P1 rulebook, P2 errata, P3 designer, P4 community consensus, P5 rulebook without provenance.
const SOURCES: readonly CitedSource[] = [
  src('chk_rules', 'OFFICIAL_RULES'),
  src('chk_errata', 'OFFICIAL_ERRATA'),
  src('chk_designer', 'DESIGNER_OR_PUBLISHER'),
  src('chk_forum', 'COMMUNITY_CONSENSUS'),
  src('chk_bare', 'OFFICIAL_RULES', []),
];
const labels = new Map(SOURCES.map((s, i) => [`P${i + 1}`, s.chunkId]));
const sources = new Map(SOURCES.map((s) => [s.chunkId, s]));

const model = (over: Partial<ModelAnswer> = {}): ModelAnswer => ({
  appliedTier: 'OFFICIAL',
  certainty: 'DEFINITIVE',
  answer: 'Yes, you may.',
  explanation: 'The rulebook says so.',
  evidence: ['P1'],
  tiers: [
    {
      tier: 'OFFICIAL',
      answer: 'Yes, you may.',
      certainty: 'DEFINITIVE',
      evidence: ['P1'],
      disagreesWithApplied: false,
    },
  ],
  ...over,
});

/** Every validated answer must be schema-valid; returns it for further assertions. */
const run = (output: ModelAnswer): RulesAnswer => {
  const got = validateAnswer(output, labels, sources);
  expect(RulesAnswerSchema.parse(got)).toEqual(got);
  return got;
};

const NOT_SETTLED = inconclusiveAnswer('x').answer;

const expectInconclusive = (got: RulesAnswer): void => {
  expect(got).toMatchObject({
    certainty: 'INCONCLUSIVE',
    answer: NOT_SETTLED,
    authority: 'UNKNOWN',
    evidence: [],
    appliedTier: null,
    needsResearch: true,
    confidence: { level: 'LOW', reasons: ['NOT_SETTLED'] },
  });
};

describe('validateAnswer: applied ruling', () => {
  it.each(['', '   \n\t'])('downgrades a %j applied answer to INCONCLUSIVE', (answer) => {
    const got = run(model({ answer }));
    expectInconclusive(got);
    expect(got.explanation).not.toContain('The rulebook says so.');
  });

  it('caps an applied ruling citing OFFICIAL and COMMUNITY passages at MEDIUM', () => {
    const got = run(model({ evidence: ['P1', 'P4'] }));
    expect(got.appliedTier).toBe('OFFICIAL');
    expect(got.confidence).toEqual({
      level: 'MEDIUM',
      reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'COMMUNITY_SOURCE'],
    });
  });

  it('passes a good DEFINITIVE official answer with HIGH confidence', () => {
    const got = run(model());
    expect(got).toEqual({
      certainty: 'DEFINITIVE',
      authority: 'OFFICIAL_RULES',
      answer: 'Yes, you may.',
      explanation: 'The rulebook says so.',
      evidence: [{ chunkId: 'chk_rules' }],
      needsResearch: false,
      confidence: { level: 'HIGH', reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED'] },
      appliedTier: 'OFFICIAL',
      tiers: [
        {
          tier: 'OFFICIAL',
          answer: 'Yes, you may.',
          certainty: 'DEFINITIVE',
          evidence: [{ chunkId: 'chk_rules' }],
          confidence: { level: 'HIGH', reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED'] },
        },
      ],
      sourcesDisagree: false,
      requiresPlayerChoice: false,
    });
  });

  it('takes the highest authority when rulebook and errata are cited', () => {
    const got = run(model({ evidence: ['P1', 'P2'] }));
    expect(got.authority).toBe('OFFICIAL_ERRATA');
    expect(got.evidence).toEqual([{ chunkId: 'chk_rules' }, { chunkId: 'chk_errata' }]);
  });

  it('turns an unknown label into INCONCLUSIVE with no evidence (Review Focus 1)', () => {
    const got = run(model({ evidence: ['P1', 'P9'] }));
    expectInconclusive(got);
    expect(got.answer).not.toBe('Yes, you may.');
  });

  it('treats a label whose chunk was not sent as unknown', () => {
    const got = validateAnswer(model(), new Map([['P1', 'chk_missing']]), sources);
    expect(RulesAnswerSchema.parse(got)).toEqual(got);
    expectInconclusive(got);
  });

  it('treats a label mapped to an empty chunk id as unknown', () => {
    const withEmpty = new Map([...sources, ['', src('', 'OFFICIAL_RULES')]]);
    const got = validateAnswer(model(), new Map([['P1', '']]), withEmpty);
    expect(RulesAnswerSchema.parse(got)).toEqual(got);
    expectInconclusive(got);
  });

  it('cites the chunk id as sent even if the source record disagrees', () => {
    const odd = new Map([['chk_rules', src('', 'OFFICIAL_RULES')]]);
    const got = validateAnswer(model(), new Map([['P1', 'chk_rules']]), odd);
    expect(RulesAnswerSchema.parse(got)).toEqual(got);
    expect(got.evidence).toEqual([{ chunkId: 'chk_rules' }]);
    expect(got.tiers[0]?.evidence).toEqual([{ chunkId: 'chk_rules' }]);
  });

  it.each(['DEFINITIVE', 'QUALIFIED'] as const)(
    'turns %s with no evidence into INCONCLUSIVE',
    (c) => {
      const got = run(model({ certainty: c, evidence: [] }));
      expectInconclusive(got);
      expect(got.answer).not.toBe('Yes, you may.');
    },
  );

  it('strips evidence and tier from a model INCONCLUSIVE, moving its wording to the explanation', () => {
    const got = run(
      model({
        certainty: 'INCONCLUSIVE',
        appliedTier: 'OFFICIAL',
        answer: 'Probably yes, you may move twice.',
        explanation: 'The passages only hint at it.',
        evidence: ['P1', 'P2'],
      }),
    );
    expectInconclusive(got);
    expect(got.answer).toBe(NOT_SETTLED);
    expect(got.explanation).toContain('Probably yes, you may move twice.');
    expect(got.explanation).toContain('The passages only hint at it.');
  });

  it('gives a non-empty explanation for a model INCONCLUSIVE with no wording', () => {
    const got = run(
      model({ certainty: 'INCONCLUSIVE', answer: ' ', explanation: '', evidence: [] }),
    );
    expect(got.answer).toBe(NOT_SETTLED);
    expect(got.explanation.trim().length).toBeGreaterThan(0);
  });

  it('never shows a rejected ruling as the answer or explanation', () => {
    const got = run(model({ answer: 'Yes, you may.', evidence: ['P9'] }));
    expect(got.answer).toBe(NOT_SETTLED);
    expect(got.explanation).not.toContain('Yes, you may.');
  });

  it('derives tier from authority, ignoring a forged tier (attack: community passed as OFFICIAL)', () => {
    const forged = {
      chunkId: 'chk_forged',
      tier: 'OFFICIAL',
      authority: 'COMMUNITY_CONSENSUS',
      provenance: [attested('COMMUNITY_CONSENSUS')],
    } as CitedSource;
    const got = validateAnswer(
      model({
        appliedTier: 'OFFICIAL',
        evidence: ['P1'],
        tiers: [
          {
            tier: 'OFFICIAL',
            answer: 'Yes.',
            certainty: 'DEFINITIVE',
            evidence: ['P1'],
            disagreesWithApplied: false,
          },
        ],
      }),
      new Map([['P1', 'chk_forged']]),
      new Map([['chk_forged', forged]]),
    );
    expect(RulesAnswerSchema.parse(got)).toEqual(got);
    expect(got.appliedTier).toBe('COMMUNITY_CONSENSUS');
    expect(got.authority).toBe('COMMUNITY_CONSENSUS');
    expect(got.confidence).toEqual({
      level: 'MEDIUM',
      reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'COMMUNITY_SOURCE'],
    });
    expect(got.tiers).toEqual([]);
  });

  it('de-duplicates repeated labels in the applied evidence', () => {
    const got = run(model({ evidence: ['P1', 'P1', 'P2', 'P1'] }));
    expect(got.evidence).toEqual([{ chunkId: 'chk_rules' }, { chunkId: 'chk_errata' }]);
  });

  it('de-duplicates two labels that resolve to the same chunk', () => {
    const twoLabels = new Map([...labels, ['P6', 'chk_rules']]);
    const got = validateAnswer(model({ evidence: ['P1', 'P6'] }), twoLabels, sources);
    expect(RulesAnswerSchema.parse(got)).toEqual(got);
    expect(got.evidence).toEqual([{ chunkId: 'chk_rules' }]);
  });

  it('corrects an appliedTier that does not match the cited sources', () => {
    const got = run(
      model({
        appliedTier: 'COMMUNITY_CONSENSUS',
        evidence: ['P4', 'P3'],
        tiers: [],
      }),
    );
    expect(got.appliedTier).toBe('DESIGNER_OR_PUBLISHER');
    expect(got.authority).toBe('DESIGNER_OR_PUBLISHER');
  });

  it('fills a null appliedTier on a supported ruling from the cited sources', () => {
    const got = run(model({ appliedTier: null }));
    expect(got.appliedTier).toBe('OFFICIAL');
  });

  it('caps confidence at MEDIUM for a source with empty provenance', () => {
    const got = run(
      model({
        evidence: ['P5'],
        tiers: [
          {
            tier: 'OFFICIAL',
            answer: 'x',
            certainty: 'DEFINITIVE',
            evidence: ['P5'],
            disagreesWithApplied: false,
          },
        ],
      }),
    );
    expect(got.confidence).toEqual({
      level: 'MEDIUM',
      reasons: ['DIRECTLY_STATED', 'MISSING_PROVENANCE'],
    });
  });

  it('caps a community ruling at MEDIUM', () => {
    const got = run(
      model({
        appliedTier: 'COMMUNITY_CONSENSUS',
        evidence: ['P4'],
        tiers: [
          {
            tier: 'COMMUNITY_CONSENSUS',
            answer: 'x',
            certainty: 'DEFINITIVE',
            evidence: ['P4'],
            disagreesWithApplied: false,
          },
        ],
      }),
    );
    expect(got.authority).toBe('COMMUNITY_CONSENSUS');
    expect(got.confidence.level).toBe('MEDIUM');
    expect(got.confidence.reasons).toContain('COMMUNITY_SOURCE');
  });
});

describe('validateAnswer: tier panels', () => {
  const officialPanel = {
    tier: 'OFFICIAL' as const,
    answer: 'Yes.',
    certainty: 'DEFINITIVE' as const,
    evidence: ['P1'],
    disagreesWithApplied: false,
  };
  const designer = (answer: string, disagreesWithApplied: boolean) => ({
    tier: 'DESIGNER_OR_PUBLISHER' as const,
    answer,
    certainty: 'DEFINITIVE' as const,
    evidence: ['P3'],
    disagreesWithApplied,
  });
  const community = (answer: string, disagreesWithApplied: boolean) => ({
    tier: 'COMMUNITY_CONSENSUS' as const,
    answer,
    certainty: 'DEFINITIVE' as const,
    evidence: ['P4'],
    disagreesWithApplied,
  });

  it('drops a community panel citing an OFFICIAL passage (Review Focus 2)', () => {
    const got = run(
      model({ tiers: [officialPanel, { ...community('No.', true), evidence: ['P1'] }] }),
    );
    expect(got.tiers.map((t) => t.tier)).toEqual(['OFFICIAL']);
    expect(got.sourcesDisagree).toBe(false);
  });

  it('drops a panel mixing its own tier with another tier', () => {
    const got = run(
      model({ tiers: [officialPanel, { ...community('No.', true), evidence: ['P4', 'P1'] }] }),
    );
    expect(got.tiers.map((t) => t.tier)).toEqual(['OFFICIAL']);
  });

  it('drops a panel with an unknown label', () => {
    const got = run(
      model({ tiers: [officialPanel, { ...designer('Yes.', false), evidence: ['P3', 'P7'] }] }),
    );
    expect(got.tiers.map((t) => t.tier)).toEqual(['OFFICIAL']);
  });

  it('drops a panel with no evidence', () => {
    const got = run(
      model({ tiers: [officialPanel, { ...officialPanel, tier: 'UNKNOWN', evidence: [] }] }),
    );
    expect(got.tiers.map((t) => t.tier)).toEqual(['OFFICIAL']);
  });

  it.each(['', '  \n\t'])('drops a panel whose answer is %j', (answer) => {
    const got = run(model({ tiers: [officialPanel, designer(answer, true)] }));
    expect(got.tiers.map((t) => t.tier)).toEqual(['OFFICIAL']);
    expect(got.sourcesDisagree).toBe(false);
  });

  it('drops an INCONCLUSIVE panel even when it carries evidence', () => {
    const got = run(
      model({ tiers: [officialPanel, { ...designer('?', true), certainty: 'INCONCLUSIVE' }] }),
    );
    expect(got.tiers.map((t) => t.tier)).toEqual(['OFFICIAL']);
    expect(got.sourcesDisagree).toBe(false);
    expect(got.requiresPlayerChoice).toBe(false);
  });

  it('keeps only the first surviving panel per tier', () => {
    const got = run(
      model({ tiers: [officialPanel, { ...officialPanel, answer: 'Other.', evidence: ['P2'] }] }),
    );
    expect(got.tiers).toHaveLength(1);
    expect(got.tiers[0]?.answer).toBe('Yes.');
  });

  it('de-duplicates panel evidence', () => {
    const got = run(model({ tiers: [{ ...officialPanel, evidence: ['P1', 'P2', 'P1'] }] }));
    expect(got.tiers[0]?.evidence).toEqual([{ chunkId: 'chk_rules' }, { chunkId: 'chk_errata' }]);
  });
});

describe('validateAnswer: disagreement between tiers', () => {
  const officialPanel = {
    tier: 'OFFICIAL' as const,
    answer: 'Yes.',
    certainty: 'DEFINITIVE' as const,
    evidence: ['P1'],
    disagreesWithApplied: false,
  };
  const designer = (disagreesWithApplied: boolean) => ({
    tier: 'DESIGNER_OR_PUBLISHER' as const,
    answer: disagreesWithApplied ? 'No.' : 'Yes.',
    certainty: 'DEFINITIVE' as const,
    evidence: ['P3'],
    disagreesWithApplied,
  });
  const community = (disagreesWithApplied: boolean) => ({
    tier: 'COMMUNITY_CONSENSUS' as const,
    answer: disagreesWithApplied ? 'No.' : 'Yes.',
    certainty: 'DEFINITIVE' as const,
    evidence: ['P4'],
    disagreesWithApplied,
  });

  it('reports no disagreement when every panel agrees with the applied ruling', () => {
    const got = run(model({ tiers: [officialPanel, designer(false), community(false)] }));
    expect(got.sourcesDisagree).toBe(false);
    expect(got.requiresPlayerChoice).toBe(false);
    expect(got.confidence.reasons).not.toContain('SOURCES_DISAGREE');
  });

  it('does not require a player choice when OFFICIAL and DESIGNER agree and only COMMUNITY disagrees (Codex P2)', () => {
    const got = run(model({ tiers: [officialPanel, designer(false), community(true)] }));
    expect(got.sourcesDisagree).toBe(true);
    expect(got.requiresPlayerChoice).toBe(false);
    expect(got.certainty).toBe('DEFINITIVE');
    expect(got.confidence).toEqual({
      level: 'MEDIUM',
      reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'SOURCES_DISAGREE'],
    });
  });

  it('flags an OFFICIAL ruling that a DESIGNER panel disagrees with as a player choice', () => {
    const got = run(model({ tiers: [officialPanel, designer(true)] }));
    expect(got.requiresPlayerChoice).toBe(true);
    expect(got.sourcesDisagree).toBe(true);
    expect(got.certainty).toBe('QUALIFIED');
    expect(got.authority).toBe('OFFICIAL_RULES');
    expect(got.confidence).toEqual({
      level: 'LOW',
      reasons: ['BEST_READING', 'OPERATOR_ATTESTED', 'SOURCES_DISAGREE'],
    });
  });

  it('flags a DESIGNER ruling that an OFFICIAL panel disagrees with as a player choice', () => {
    const got = run(
      model({
        appliedTier: 'DESIGNER_OR_PUBLISHER',
        evidence: ['P3'],
        tiers: [{ ...officialPanel, disagreesWithApplied: true }, designer(false)],
      }),
    );
    expect(got.appliedTier).toBe('DESIGNER_OR_PUBLISHER');
    expect(got.requiresPlayerChoice).toBe(true);
    expect(got.certainty).toBe('QUALIFIED');
  });

  it('treats an OFFICIAL applied ruling with no OFFICIAL panel as the official side', () => {
    const got = run(model({ tiers: [designer(true)] }));
    expect(got.sourcesDisagree).toBe(true);
    expect(got.requiresPlayerChoice).toBe(true);
    expect(got.certainty).toBe('QUALIFIED');
  });

  it('flags OFFICIAL vs DESIGNER whenever exactly one of them disagrees with the applied ruling', () => {
    // An inconsistent model: the applied ruling cites an official passage, its OFFICIAL panel
    // says it differs, and the DESIGNER panel matches it. The two panels still differ.
    const got = run(
      model({ tiers: [{ ...officialPanel, disagreesWithApplied: true }, designer(false)] }),
    );
    expect(got.requiresPlayerChoice).toBe(true);
  });

  it('does not claim an OFFICIAL vs DESIGNER conflict when both differ from a community ruling', () => {
    // Both differ from the applied ruling, which cannot say whether they differ from each other.
    const got = run(
      model({
        appliedTier: 'COMMUNITY_CONSENSUS',
        evidence: ['P4'],
        tiers: [{ ...officialPanel, disagreesWithApplied: true }, designer(true), community(false)],
      }),
    );
    expect(got.appliedTier).toBe('COMMUNITY_CONSENSUS');
    expect(got.sourcesDisagree).toBe(true);
    expect(got.requiresPlayerChoice).toBe(false);
  });

  it('ignores the flag on a dropped panel', () => {
    const got = run(model({ tiers: [officialPanel, { ...designer(true), evidence: ['P1'] }] }));
    expect(got.sourcesDisagree).toBe(false);
    expect(got.requiresPlayerChoice).toBe(false);
  });

  it('drops each panel a level when sources disagree', () => {
    const got = run(
      model({ tiers: [officialPanel, { ...community(true), certainty: 'QUALIFIED' }] }),
    );
    expect(got.tiers.map((t) => t.confidence)).toEqual([
      { level: 'MEDIUM', reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'SOURCES_DISAGREE'] },
      {
        level: 'LOW',
        reasons: ['BEST_READING', 'OPERATOR_ATTESTED', 'COMMUNITY_SOURCE', 'SOURCES_DISAGREE'],
      },
    ]);
  });

  it('flags OFFICIAL vs DESIGNER on an INCONCLUSIVE ruling from the panel flags alone', () => {
    const got = run(
      model({
        certainty: 'INCONCLUSIVE',
        evidence: [],
        tiers: [officialPanel, designer(true)],
      }),
    );
    expect(got.certainty).toBe('INCONCLUSIVE');
    expect(got.sourcesDisagree).toBe(true);
    expect(got.requiresPlayerChoice).toBe(true);
  });

  it('keeps valid panels when the applied ruling is rejected', () => {
    const got = run(model({ evidence: ['P9'] }));
    expectInconclusive(got);
    expect(got.tiers.map((t) => t.tier)).toEqual(['OFFICIAL']);
  });
});

describe('validateAnswer: never throws on schema-valid garbage', () => {
  it.each<[string, ModelAnswer]>([
    [
      'empty everything',
      {
        appliedTier: null,
        certainty: 'DEFINITIVE',
        answer: '',
        explanation: '',
        evidence: [],
        tiers: [],
      },
    ],
    [
      'labels that are not labels',
      model({ evidence: ['', ' ', 'chk_rules', '__proto__', 'constructor'] }),
    ],
    [
      'panels full of junk',
      model({
        tiers: [
          {
            tier: 'UNKNOWN',
            answer: '',
            certainty: 'QUALIFIED',
            evidence: ['toString'],
            disagreesWithApplied: false,
          },
          {
            tier: 'OFFICIAL',
            answer: '',
            certainty: 'INCONCLUSIVE',
            evidence: [],
            disagreesWithApplied: true,
          },
        ],
      }),
    ],
  ])('%s', (_name, output) => {
    expect(() => run(output)).not.toThrow();
  });

  it('turns garbage applied labels into INCONCLUSIVE', () => {
    expectInconclusive(run(model({ evidence: ['__proto__'] })));
  });
});

describe('inconclusiveAnswer', () => {
  it('is a schema-valid INCONCLUSIVE ruling with the given explanation', () => {
    const got = inconclusiveAnswer('The model returned an invalid answer.');
    expect(RulesAnswerSchema.parse(got)).toEqual(got);
    expect(got).toEqual({
      certainty: 'INCONCLUSIVE',
      authority: 'UNKNOWN',
      answer: expect.any(String),
      explanation: 'The model returned an invalid answer.',
      evidence: [],
      needsResearch: true,
      confidence: { level: 'LOW', reasons: ['NOT_SETTLED'] },
      appliedTier: null,
      tiers: [],
      sourcesDisagree: false,
      requiresPlayerChoice: false,
    });
    expect(got.answer.length).toBeGreaterThan(0);
  });

  it('returns a fresh confidence object each time', () => {
    const first = inconclusiveAnswer('a');
    first.confidence.reasons.push('SOURCES_DISAGREE');
    first.confidence.level = 'HIGH';
    expect(inconclusiveAnswer('b').confidence).toEqual({ level: 'LOW', reasons: ['NOT_SETTLED'] });
    const rejected = run(model({ evidence: ['P9'] }));
    expect(rejected.confidence).toEqual({ level: 'LOW', reasons: ['NOT_SETTLED'] });
  });
});
