import { describe, expect, it } from 'vitest';
import {
  ApiError,
  type Authority,
  type Citation,
  type ProvenanceEvidence,
  type SourceType,
} from './api/client';
import {
  askErrorMessage,
  confidencePercent,
  provenanceLine,
  sourceSummary,
  tierLabel,
} from './answer-view';

function cite(
  chunkId: string,
  documentId: string,
  pageStart: number,
  pageEnd: number,
  sourceType: SourceType = 'RULEBOOK',
  title = 'Rulebook',
): Citation {
  return {
    chunkId,
    documentId,
    title,
    sourceType,
    authority: 'OFFICIAL_RULES',
    pageStart,
    pageEnd,
    headingPath: [],
    text: '',
    provenance: [],
  };
}

describe('confidencePercent', () => {
  it('maps levels', () => {
    expect(confidencePercent('HIGH')).toBe(85);
    expect(confidencePercent('MEDIUM')).toBe(50);
    expect(confidencePercent('LOW')).toBe(25);
  });
});

describe('tierLabel', () => {
  it('maps every tier', () => {
    expect(tierLabel('OFFICIAL')).toBe('Official rules');
    expect(tierLabel('DESIGNER_OR_PUBLISHER')).toBe('Publisher ruling');
    expect(tierLabel('COMMUNITY_CONSENSUS')).toBe('Community consensus');
    expect(tierLabel('COMMUNITY_DISCUSSION')).toBe('Community discussion');
    expect(tierLabel('UNKNOWN')).toBe('Unknown source');
  });
});

describe('sourceSummary', () => {
  it('is empty when nothing resolves', () => {
    expect(sourceSummary([], [])).toBe('');
    expect(sourceSummary([{ chunkId: 'x' }], [cite('a', 'd1', 1, 1)])).toBe('');
  });
  it('names a single rulebook page', () => {
    expect(sourceSummary([{ chunkId: 'a' }], [cite('a', 'd1', 3, 3)])).toBe('Rulebook p.3');
  });
  it('uses an en dash for a page range, across chunks of one document', () => {
    const cs = [cite('a', 'd1', 3, 3), cite('b', 'd1', 4, 4)];
    expect(sourceSummary([{ chunkId: 'a' }, { chunkId: 'b' }], cs)).toBe('Rulebook p.3–4');
    expect(sourceSummary([{ chunkId: 'a' }], [cite('a', 'd1', 3, 4)])).toBe('Rulebook p.3–4');
  });
  it('uses the title for non-rulebooks', () => {
    const c = cite('a', 'd2', 2, 2, 'FAQ', 'Stonemaier FAQ');
    expect(sourceSummary([{ chunkId: 'a' }], [c])).toBe('Stonemaier FAQ, p.2');
    const r = cite('b', 'd2', 2, 5, 'FAQ', 'Stonemaier FAQ');
    expect(sourceSummary([{ chunkId: 'b' }], [r])).toBe('Stonemaier FAQ, p.2–5');
  });
  it('counts distinct documents', () => {
    const cs = [cite('a', 'd1', 3, 3), cite('b', 'd2', 1, 1, 'FAQ', 'FAQ')];
    expect(sourceSummary([{ chunkId: 'a' }, { chunkId: 'b' }], cs)).toBe('2 sources');
  });
});

describe('provenanceLine', () => {
  it('is empty for no evidence', () => {
    expect(provenanceLine([])).toBe('');
  });
  it('phrases every kind', () => {
    const authorities: Authority[] = [
      'OFFICIAL_RULES',
      'OFFICIAL_ERRATA',
      'DESIGNER_OR_PUBLISHER',
      'COMMUNITY_CONSENSUS',
      'COMMUNITY_DISCUSSION',
      'UNKNOWN',
    ];
    expect(
      provenanceLine([{ kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_RULES', recordedAt: 't' }]),
    ).toBe('added by the operator as official rules ✓');
    for (const a of authorities) {
      const line = provenanceLine([{ kind: 'OPERATOR_ATTESTED', authority: a, recordedAt: 't' }]);
      expect(line).toMatch(/^added by the operator as .+ ✓$/);
      expect(line).not.toContain('_');
    }
    expect(provenanceLine([{ kind: 'SOURCE_HOST', host: 'example.com' }])).toBe(
      'fetched from example.com',
    );
    expect(provenanceLine([{ kind: 'UPLOADED_FILE', filename: 'rules.pdf' }])).toBe(
      'uploaded file rules.pdf',
    );
    expect(provenanceLine([{ kind: 'UPLOADED_FILE' }])).toBe('uploaded file');
    expect(
      provenanceLine([
        {
          kind: 'COMMUNITY_HOST_DOWNGRADE',
          host: 'bgg.com',
          from: 'OFFICIAL_RULES',
          to: 'COMMUNITY_DISCUSSION',
        },
      ]),
    ).toBe(
      'bgg.com is a community site, so it was downgraded from official rules to community discussion',
    );
    expect(provenanceLine([{ kind: 'COMMUNITY_CONTENT_REMOVED', regions: 2 }])).toBe(
      '2 community-written sections removed',
    );
    expect(provenanceLine([{ kind: 'COMMUNITY_CONTENT_REMOVED', regions: 1 }])).toBe(
      '1 community-written section removed',
    );
  });
  it('joins with a middle dot', () => {
    const ev: ProvenanceEvidence[] = [
      { kind: 'SOURCE_HOST', host: 'a.com' },
      { kind: 'UPLOADED_FILE' },
    ];
    expect(provenanceLine(ev)).toBe('fetched from a.com · uploaded file');
  });
});

describe('askErrorMessage', () => {
  const generic = { message: 'Something went wrong. Please try again.', sessionEnded: false };
  it('maps the daily limit', () => {
    expect(askErrorMessage(new ApiError(429, 'DAILY_LIMIT_REACHED', 'x'))).toEqual({
      message: "Today's question limit is used up. Try again tomorrow.",
      sessionEnded: false,
    });
  });
  it('passes through server messages for infrastructure errors', () => {
    expect(askErrorMessage(new ApiError(503, 'MODEL_UNAVAILABLE', 'model down'))).toEqual({
      message: 'model down',
      sessionEnded: false,
    });
    expect(askErrorMessage(new ApiError(503, 'RETRIEVAL_UNAVAILABLE', 'search down'))).toEqual({
      message: 'search down',
      sessionEnded: false,
    });
  });
  it('treats any 404 as an ended session', () => {
    const expected = {
      message: 'This session has ended. Start a new one from the game screen.',
      sessionEnded: true,
    };
    expect(askErrorMessage(new ApiError(404, 'NOT_FOUND', 'gone'))).toEqual(expected);
    expect(askErrorMessage(new ApiError(404, 'UNKNOWN', 'Not Found'))).toEqual(expected);
  });
  it('maps conflict', () => {
    expect(askErrorMessage(new ApiError(409, 'CONFLICT', 'x'))).toEqual({
      message: 'Another question is still being answered. Try again in a moment.',
      sessionEnded: false,
    });
  });
  it('falls back for everything else', () => {
    expect(askErrorMessage(new ApiError(500, 'INTERNAL_ERROR', 'boom'))).toEqual(generic);
    expect(askErrorMessage(new Error('x'))).toEqual(generic);
    expect(askErrorMessage('str')).toEqual(generic);
    expect(askErrorMessage(undefined)).toEqual(generic);
  });
});
