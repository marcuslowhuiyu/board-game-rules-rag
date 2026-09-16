import { describe, expect, it } from 'vitest';
import {
  ContentPackageSchema,
  CreateGameInputSchema,
  CreateSessionInputSchema,
  EditionSchema,
  GameSchema,
  MessageSchema,
  SessionSchema,
  SourceDocumentMetadataSchema,
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

  it('accepts a SourceDocumentMetadata', () => {
    const parsed = SourceDocumentMetadataSchema.parse({
      documentId: 'doc1',
      gameId: 'game1',
      editionId: 'ed1',
      contentId: 'c-a',
      title: 'Rulebook',
      sourceType: 'RULEBOOK',
      authority: 'OFFICIAL_RULES',
      status: 'ACTIVE',
      supersedes: [],
      createdAt: iso,
      updatedAt: iso,
    });
    expect(parsed.sourceType).toBe('RULEBOOK');
  });
});
