import { describe, expect, it } from 'vitest';
import {
  ChunkSchema,
  ContentPackageSchema,
  CreateGameInputSchema,
  CreateIngestionJobInputSchema,
  CreatePresignedUploadInputSchema,
  CreateSessionInputSchema,
  EditionSchema,
  GameSchema,
  IngestionJobSchema,
  MessageSchema,
  SessionSchema,
  SourceDocumentSchema,
} from './index.js';

const iso = '2026-09-16T00:00:00.000Z';

describe('domain schemas', () => {
  it('accepts a valid Game', () => {
    const parsed = GameSchema.parse({
      gameId: 'game1',
      slug: 'twilight-imperium',
      name: 'Twilight Imperium',
      publisher: 'FFG',
      editions: [],
      createdAt: iso,
      updatedAt: iso,
    });
    expect(parsed.slug).toBe('twilight-imperium');
  });

  it('rejects a Game with a non-kebab slug', () => {
    const result = GameSchema.safeParse({
      gameId: 'game1',
      slug: 'Twilight Imperium',
      name: 'Twilight Imperium',
      editions: [],
      createdAt: iso,
      updatedAt: iso,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a Game id with a slash', () => {
    const result = GameSchema.safeParse({
      gameId: 'not/allowed',
      slug: 'twilight-imperium',
      name: 'x',
      editions: [],
      createdAt: iso,
      updatedAt: iso,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an Edition', () => {
    const parsed = EditionSchema.parse({
      editionId: 'ed1',
      gameId: 'game1',
      name: '4th Edition',
      createdAt: iso,
      updatedAt: iso,
    });
    expect(parsed.name).toBe('4th Edition');
  });

  it('accepts a ContentPackage with each content type', () => {
    for (const contentType of [
      'BASE',
      'EXPANSION',
      'PROMO',
      'MODULE',
      'MINI_EXPANSION',
      'OTHER_OPTIONAL_CONTENT',
    ] as const) {
      const parsed = ContentPackageSchema.parse({
        contentId: `c-${contentType.toLowerCase()}`,
        gameId: 'game1',
        editionId: 'ed1',
        slug: 'prophecy-of-kings',
        name: 'Prophecy of Kings',
        contentType,
        dependencies: [],
        status: 'READY',
      });
      expect(parsed.contentType).toBe(contentType);
    }
  });

  it('rejects an unknown contentType', () => {
    const result = ContentPackageSchema.safeParse({
      contentId: 'c-x',
      gameId: 'game1',
      editionId: 'ed1',
      slug: 'x',
      name: 'x',
      contentType: 'SUPPLEMENT',
      status: 'READY',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a Session with fingerprint length 64', () => {
    const parsed = SessionSchema.parse({
      sessionId: 'sess1',
      gameId: 'game1',
      editionId: 'ed1',
      enabledContentIds: ['c-a', 'c-b'],
      configurationFingerprint: 'a'.repeat(64),
      createdAt: iso,
      updatedAt: iso,
      expiresAt: iso,
      ttl: 1_800_000_000,
    });
    expect(parsed.enabledContentIds).toEqual(['c-a', 'c-b']);
  });

  it('accepts a CreateSession input', () => {
    const parsed = CreateSessionInputSchema.parse({
      gameId: 'game1',
      editionId: 'ed1',
      enabledContentIds: ['c-a'],
    });
    expect(parsed.gameId).toBe('game1');
  });

  it('accepts a CreateGame input with just a name', () => {
    const parsed = CreateGameInputSchema.parse({ name: 'Root' });
    expect(parsed.name).toBe('Root');
  });

  it('accepts a Message', () => {
    const parsed = MessageSchema.parse({
      messageId: 'm1',
      sessionId: 'sess1',
      index: 0,
      role: 'USER',
      content: 'hi',
      createdAt: iso,
    });
    expect(parsed.role).toBe('USER');
  });

  it('accepts a SourceDocument', () => {
    const parsed = SourceDocumentSchema.parse({
      documentId: 'doc1',
      gameId: 'game1',
      editionId: 'ed1',
      contentId: 'c-a',
      title: 'Rulebook',
      sourceType: 'RULEBOOK',
      authority: 'OFFICIAL_RULES',
      origin: 'UPLOAD',
      contentHash: 'a'.repeat(64),
      rawObjectUri: 's3://bucket/raw/doc1.pdf',
      status: 'CURRENT',
      supersedes: [],
      createdAt: iso,
      updatedAt: iso,
    });
    expect(parsed.sourceType).toBe('RULEBOOK');
    expect(parsed.knowledgeRevision).toBe(0);
    expect(parsed.chunkCount).toBe(0);
  });

  it('rejects a SourceDocument with a malformed contentHash', () => {
    const result = SourceDocumentSchema.safeParse({
      documentId: 'doc1',
      gameId: 'game1',
      editionId: 'ed1',
      contentId: 'c-a',
      title: 'Rulebook',
      sourceType: 'RULEBOOK',
      authority: 'OFFICIAL_RULES',
      origin: 'UPLOAD',
      contentHash: 'nope',
      rawObjectUri: 's3://bucket/raw/doc1.pdf',
      status: 'CURRENT',
      supersedes: [],
      createdAt: iso,
      updatedAt: iso,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a Chunk', () => {
    const parsed = ChunkSchema.parse({
      chunkId: 'ch_1',
      documentId: 'doc1',
      gameId: 'game1',
      editionId: 'ed1',
      contentId: 'c-a',
      ordinal: 0,
      headingPath: ['Space Combat', 'Assign Hits'],
      pageStart: 12,
      pageEnd: 12,
      textUri: 's3://bucket/normalized/doc1/ch_1.txt',
      textPreview: 'The attacker assigns hits produced by their own units.',
      charCount: 54,
      tokenCount: 12,
      authority: 'OFFICIAL_RULES',
      sourceType: 'RULEBOOK',
      isCurrent: true,
      createdAt: iso,
    });
    expect(parsed.headingPath).toEqual(['Space Combat', 'Assign Hits']);
  });

  it('accepts a CreateIngestionJob (S3) input', () => {
    const parsed = CreateIngestionJobInputSchema.parse({
      gameId: 'game1',
      editionId: 'ed1',
      contentId: 'c-a',
      title: 'Rulebook',
      sourceType: 'RULEBOOK',
      authority: 'OFFICIAL_RULES',
      source: { kind: 'S3', s3Key: 'raw/x.pdf', contentType: 'application/pdf' },
    });
    expect(parsed.source.kind).toBe('S3');
  });

  it('accepts a CreateIngestionJob (URL) input', () => {
    const parsed = CreateIngestionJobInputSchema.parse({
      gameId: 'game1',
      editionId: 'ed1',
      contentId: 'c-a',
      title: 'Living Rules',
      sourceType: 'LIVING_RULES',
      authority: 'OFFICIAL_RULES',
      source: { kind: 'URL', url: 'https://publisher.example.com/rules' },
    });
    expect(parsed.source.kind).toBe('URL');
  });

  it('accepts an IngestionJob record', () => {
    const parsed = IngestionJobSchema.parse({
      jobId: 'job_1',
      gameId: 'game1',
      editionId: 'ed1',
      contentId: 'c-a',
      title: 'Rulebook',
      sourceType: 'RULEBOOK',
      authority: 'OFFICIAL_RULES',
      source: { kind: 'S3', s3Key: 'raw/x.pdf', contentType: 'application/pdf' },
      status: 'RUNNING',
      stage: 'PARSE',
      completedStages: ['VALIDATE', 'FETCH'],
      createdAt: iso,
      updatedAt: iso,
    });
    expect(parsed.stage).toBe('PARSE');
  });

  it('rejects an oversized upload presign request', () => {
    const result = CreatePresignedUploadInputSchema.safeParse({
      filename: 'huge.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100 * 1024 * 1024,
    });
    expect(result.success).toBe(false);
  });
});
