import { describe, expect, it } from 'vitest';
import { ProvenanceEvidenceSchema, SourceDocumentSchema } from './index.js';

const iso = '2026-10-28T00:00:00.000Z';

const legacyDoc = {
  documentId: 'doc_1',
  gameId: 'g_1',
  editionId: 'e_1',
  contentId: 'c_1',
  title: 'Base Rulebook',
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  origin: 'UPLOAD',
  contentHash: 'a'.repeat(64),
  rawObjectUri: 's3://bucket/raw/doc_1.pdf',
  status: 'CURRENT',
  createdAt: iso,
  updatedAt: iso,
};

describe('provenance evidence', () => {
  it('parses a legacy document without provenance', () => {
    expect(SourceDocumentSchema.parse(legacyDoc).provenance).toEqual([]);
  });

  it('accepts each evidence kind', () => {
    const samples = [
      { kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_RULES', recordedAt: iso },
      { kind: 'SOURCE_HOST', host: 'example.com' },
      { kind: 'UPLOADED_FILE', filename: 'rules.pdf' },
      { kind: 'UPLOADED_FILE' },
      {
        kind: 'COMMUNITY_HOST_DOWNGRADE',
        host: 'boardgamegeek.com',
        from: 'DESIGNER_OR_PUBLISHER',
        to: 'COMMUNITY_DISCUSSION',
      },
      { kind: 'COMMUNITY_CONTENT_REMOVED', regions: 3 },
    ];
    for (const sample of samples) {
      expect(ProvenanceEvidenceSchema.parse(sample)).toEqual(sample);
    }
  });

  it('rejects an unknown kind', () => {
    expect(ProvenanceEvidenceSchema.safeParse({ kind: 'MADE_UP' }).success).toBe(false);
  });

  it('rejects OPERATOR_ATTESTED without authority', () => {
    expect(
      ProvenanceEvidenceSchema.safeParse({ kind: 'OPERATOR_ATTESTED', recordedAt: iso }).success,
    ).toBe(false);
  });
});
