import { describe, expect, it } from 'vitest';
import { ProvenanceSchema } from '@bgr/domain';
import { buildProvenance } from './provenance.js';

const now = '2026-10-28T00:00:00.000Z';

describe('buildProvenance', () => {
  it('records the declared tier and the uploaded file', () => {
    const out = buildProvenance({
      declaredAuthority: 'OFFICIAL_RULES',
      classifiedAuthority: 'OFFICIAL_RULES',
      origin: 'UPLOAD',
      filename: 'rules.pdf',
      now,
    });
    expect(out).toEqual([
      { kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_RULES', recordedAt: now },
      { kind: 'UPLOADED_FILE', filename: 'rules.pdf' },
    ]);
    expect(() => ProvenanceSchema.parse(out)).not.toThrow();
  });

  it('records the source host and removed comment regions for a URL', () => {
    const out = buildProvenance({
      declaredAuthority: 'OFFICIAL_ERRATA',
      classifiedAuthority: 'OFFICIAL_ERRATA',
      origin: 'URL',
      canonicalUrl: 'https://stonemaiergames.com/games/wingspan/rules/',
      communityRegionsRemoved: 1,
      now,
    });
    expect(out).toEqual([
      { kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_ERRATA', recordedAt: now },
      { kind: 'SOURCE_HOST', host: 'stonemaiergames.com' },
      { kind: 'COMMUNITY_CONTENT_REMOVED', regions: 1 },
    ]);
    expect(() => ProvenanceSchema.parse(out)).not.toThrow();
  });

  it('explains a community host downgrade while keeping the declared tier', () => {
    const out = buildProvenance({
      declaredAuthority: 'OFFICIAL_ERRATA',
      classifiedAuthority: 'COMMUNITY_DISCUSSION',
      origin: 'URL',
      canonicalUrl: 'https://boardgamegeek.com/thread/1',
      now,
    });
    expect(out).toContainEqual({
      kind: 'COMMUNITY_HOST_DOWNGRADE',
      host: 'boardgamegeek.com',
      from: 'OFFICIAL_ERRATA',
      to: 'COMMUNITY_DISCUSSION',
    });
    expect(out[0]).toMatchObject({ kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_ERRATA' });
    expect(() => ProvenanceSchema.parse(out)).not.toThrow();
  });

  it('omits SOURCE_HOST when the URL cannot be parsed', () => {
    const out = buildProvenance({
      declaredAuthority: 'OFFICIAL_RULES',
      classifiedAuthority: 'OFFICIAL_RULES',
      origin: 'URL',
      canonicalUrl: 'not a url',
      now,
    });
    expect(out.map((e) => e.kind)).toEqual(['OPERATOR_ATTESTED']);
  });
});
