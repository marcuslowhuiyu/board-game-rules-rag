import { ConfidenceSchema, type Authority, type ProvenanceEvidence } from '@bgr/domain';
import { describe, expect, it } from 'vitest';
import { confidenceFor } from './confidence.js';
import type { CitedSource } from './validate-answer.js';

const attested = (authority: Authority): ProvenanceEvidence => ({
  kind: 'OPERATOR_ATTESTED',
  authority,
  recordedAt: '2026-10-30T00:00:00.000Z',
});

const source = (over: Partial<CitedSource> = {}): CitedSource => ({
  chunkId: 'chk_1',
  authority: 'OFFICIAL_RULES',
  provenance: [attested('OFFICIAL_RULES')],
  ...over,
});

const community = source({
  chunkId: 'chk_c',
  authority: 'COMMUNITY_CONSENSUS',
  provenance: [attested('COMMUNITY_CONSENSUS')],
});

describe('confidenceFor', () => {
  it.each([
    {
      name: 'DEFINITIVE, attested official source',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'OFFICIAL',
        cited: [source()],
        sourcesDisagree: false,
      },
      want: { level: 'HIGH', reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED'] },
    },
    {
      name: 'QUALIFIED, attested official source',
      input: {
        certainty: 'QUALIFIED',
        tier: 'OFFICIAL',
        cited: [source()],
        sourcesDisagree: false,
      },
      want: { level: 'MEDIUM', reasons: ['BEST_READING', 'OPERATOR_ATTESTED'] },
    },
    {
      name: 'INCONCLUSIVE is always LOW and only NOT_SETTLED',
      input: {
        certainty: 'INCONCLUSIVE',
        tier: 'OFFICIAL',
        cited: [source()],
        sourcesDisagree: true,
      },
      want: { level: 'LOW', reasons: ['NOT_SETTLED'] },
    },
    {
      name: 'empty provenance caps at MEDIUM',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'OFFICIAL',
        cited: [source({ provenance: [] })],
        sourcesDisagree: false,
      },
      want: { level: 'MEDIUM', reasons: ['DIRECTLY_STATED', 'MISSING_PROVENANCE'] },
    },
    {
      name: 'attestation of a different authority than stored is not attestation',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'OFFICIAL',
        cited: [source({ provenance: [attested('OFFICIAL_ERRATA')] })],
        sourcesDisagree: false,
      },
      want: { level: 'MEDIUM', reasons: ['DIRECTLY_STATED', 'MISSING_PROVENANCE'] },
    },
    {
      name: 'a community host downgrade defeats attestation',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'OFFICIAL',
        cited: [
          source({
            provenance: [
              attested('OFFICIAL_RULES'),
              {
                kind: 'COMMUNITY_HOST_DOWNGRADE',
                host: 'example.org',
                from: 'OFFICIAL_RULES',
                to: 'COMMUNITY_DISCUSSION',
              },
            ],
          }),
        ],
        sourcesDisagree: false,
      },
      want: { level: 'MEDIUM', reasons: ['DIRECTLY_STATED', 'MISSING_PROVENANCE'] },
    },
    {
      name: 'one unattested source among attested ones is missing provenance',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'OFFICIAL',
        cited: [source(), source({ chunkId: 'chk_2', provenance: [] })],
        sourcesDisagree: false,
      },
      want: { level: 'MEDIUM', reasons: ['DIRECTLY_STATED', 'MISSING_PROVENANCE'] },
    },
    {
      name: 'no cited sources is missing provenance, not vacuously attested',
      input: { certainty: 'DEFINITIVE', tier: 'OFFICIAL', cited: [], sourcesDisagree: false },
      want: { level: 'MEDIUM', reasons: ['DIRECTLY_STATED', 'MISSING_PROVENANCE'] },
    },
    {
      name: 'community tier caps at MEDIUM',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'COMMUNITY_CONSENSUS',
        cited: [community],
        sourcesDisagree: false,
      },
      want: {
        level: 'MEDIUM',
        reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'COMMUNITY_SOURCE'],
      },
    },
    {
      name: 'UNKNOWN tier caps at MEDIUM',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'UNKNOWN',
        cited: [source({ authority: 'UNKNOWN', provenance: [attested('UNKNOWN')] })],
        sourcesDisagree: false,
      },
      want: {
        level: 'MEDIUM',
        reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'COMMUNITY_SOURCE'],
      },
    },
    {
      name: 'disagreement drops HIGH to MEDIUM',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'OFFICIAL',
        cited: [source()],
        sourcesDisagree: true,
      },
      want: {
        level: 'MEDIUM',
        reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'SOURCES_DISAGREE'],
      },
    },
    {
      name: 'disagreement drops MEDIUM to LOW',
      input: { certainty: 'QUALIFIED', tier: 'OFFICIAL', cited: [source()], sourcesDisagree: true },
      want: { level: 'LOW', reasons: ['BEST_READING', 'OPERATOR_ATTESTED', 'SOURCES_DISAGREE'] },
    },
    {
      name: 'caps then disagreement stack',
      input: {
        certainty: 'DEFINITIVE',
        tier: 'COMMUNITY_DISCUSSION',
        cited: [source({ authority: 'COMMUNITY_DISCUSSION' })],
        sourcesDisagree: true,
      },
      want: {
        level: 'LOW',
        reasons: ['DIRECTLY_STATED', 'MISSING_PROVENANCE', 'COMMUNITY_SOURCE', 'SOURCES_DISAGREE'],
      },
    },
  ] as const)('$name', ({ input, want }) => {
    const got = confidenceFor(input);
    expect(got).toEqual(want);
    expect(ConfidenceSchema.parse(got)).toEqual(got);
  });

  it.each([
    ['COMMUNITY_CONSENSUS', community],
    [
      'UNKNOWN',
      source({ chunkId: 'chk_u', authority: 'UNKNOWN', provenance: [attested('UNKNOWN')] }),
    ],
  ] as const)(
    'caps mixed OFFICIAL + %s evidence at MEDIUM with COMMUNITY_SOURCE',
    (_tier, other) => {
      expect(
        confidenceFor({
          certainty: 'DEFINITIVE',
          tier: 'OFFICIAL',
          cited: [source(), other],
          sourcesDisagree: false,
        }),
      ).toEqual({
        level: 'MEDIUM',
        reasons: ['DIRECTLY_STATED', 'OPERATOR_ATTESTED', 'COMMUNITY_SOURCE'],
      });
    },
  );
});
