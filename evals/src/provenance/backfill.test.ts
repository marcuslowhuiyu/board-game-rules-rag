import { ConflictError, SourceDocumentSchema, type SourceDocument } from '@bgr/domain';
import { InMemoryDocumentsRepository } from '@bgr/persistence';
import { describe, expect, it } from 'vitest';
import { applyBackfill, BackfillPlanSchema, planBackfill, scanAll } from './backfill.js';

const T0 = '2026-10-01T00:00:00.000Z';
const NOW = '2026-10-28T00:00:00.000Z';

const doc = (over: Record<string, unknown> & { documentId: string }): SourceDocument =>
  SourceDocumentSchema.parse({
    gameId: 'g_1',
    editionId: 'e_1',
    contentId: 'c_1',
    title: 'Rulebook',
    sourceType: 'RULEBOOK',
    authority: 'OFFICIAL_RULES',
    origin: 'URL',
    canonicalUrl: 'https://example.com/rules.pdf',
    contentHash: 'a'.repeat(64),
    rawObjectUri: 's3://b/k',
    status: 'CURRENT',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });

async function repoWith(...docs: SourceDocument[]) {
  const repo = new InMemoryDocumentsRepository();
  for (const d of docs) await repo.createDocument(d);
  return repo;
}

describe('planBackfill', () => {
  it('plans only CURRENT documents without provenance', () => {
    const plan = planBackfill(
      [
        doc({ documentId: 'doc_current' }),
        doc({ documentId: 'doc_old', status: 'SUPERSEDED' }),
        doc({
          documentId: 'doc_done',
          provenance: [{ kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_RULES', recordedAt: T0 }],
        }),
      ],
      NOW,
    );
    expect(plan.map((e) => e.documentId)).toEqual(['doc_current']);
    expect(plan[0]).toMatchObject({
      title: 'Rulebook',
      updatedAt: T0,
      confirmed: false,
      canonicalUrl: 'https://example.com/rules.pdf',
    });
    expect(plan[0]?.proposed).toEqual([
      { kind: 'OPERATOR_ATTESTED', authority: 'OFFICIAL_RULES', recordedAt: NOW },
      { kind: 'SOURCE_HOST', host: 'example.com' },
    ]);
  });
});

describe('applyBackfill', () => {
  it('applies only confirmed entries', async () => {
    const a = doc({ documentId: 'doc_a' });
    const b = doc({ documentId: 'doc_b' });
    const repo = await repoWith(a, b);
    const plan = planBackfill([a, b], NOW).map((e) => ({
      ...e,
      confirmed: e.documentId === 'doc_a',
    }));
    const result = await applyBackfill(plan, repo, NOW);
    expect(result.applied).toEqual(['doc_a']);
    expect(result.skipped).toEqual([{ documentId: 'doc_b', reason: 'not confirmed' }]);
    expect((await repo.getDocument(a.documentId))?.provenance).toHaveLength(2);
    expect((await repo.getDocument(b.documentId))?.provenance).toEqual([]);
  });

  it('skips a document whose updatedAt changed since planning', async () => {
    const a = doc({ documentId: 'doc_a' });
    const repo = await repoWith(a);
    const plan = planBackfill([a], NOW).map((e) => ({ ...e, confirmed: true }));
    await repo.updateChunkCount(a.documentId, 9, '2026-10-02T00:00:00.000Z');
    const result = await applyBackfill(plan, repo, NOW);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { documentId: 'doc_a', reason: 'changed since the plan was written' },
    ]);
    expect((await repo.getDocument(a.documentId))?.provenance).toEqual([]);
  });

  it('a second apply is a no-op', async () => {
    const a = doc({ documentId: 'doc_a' });
    const repo = await repoWith(a);
    const plan = planBackfill([a], NOW).map((e) => ({ ...e, confirmed: true }));
    await applyBackfill(plan, repo, NOW);
    const again = await applyBackfill(plan, repo, '2026-10-29T00:00:00.000Z');
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual([{ documentId: 'doc_a', reason: 'already has provenance' }]);
    expect((await repo.getDocument(a.documentId))?.provenance).toHaveLength(2);
  });
});

describe('applyBackfill races', () => {
  it('skips when setProvenance reports a ConflictError', async () => {
    const a = doc({ documentId: 'doc_a' });
    const plan = planBackfill([a], NOW).map((e) => ({ ...e, confirmed: true }));
    const stub = {
      getDocument: async () => a,
      setProvenance: async () => {
        throw new ConflictError('moved');
      },
    };
    const result = await applyBackfill(plan, stub, NOW);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { documentId: 'doc_a', reason: 'changed since the plan was written' },
    ]);
  });
});

describe('BackfillPlanSchema', () => {
  const entry = () => planBackfill([doc({ documentId: 'doc_a' })], NOW)[0]!;

  it('accepts a planned entry', () => {
    expect(BackfillPlanSchema.parse([{ ...entry(), confirmed: true }])).toHaveLength(1);
  });

  it('rejects a non-boolean confirmed', () => {
    expect(() => BackfillPlanSchema.parse([{ ...entry(), confirmed: 'false' }])).toThrow();
  });

  it('rejects a malformed proposed item', () => {
    const bad = { ...entry(), proposed: [{ kind: 'NOT_A_KIND' }] };
    expect(() => BackfillPlanSchema.parse([bad])).toThrow();
  });
});

describe('scanAll', () => {
  it('follows the continuation key until it runs out', async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      start: { items: [1, 2], next: 'p2' },
      p2: { items: [3], next: 'p3' },
      p3: { items: [4] },
    };
    const seen: Array<string | undefined> = [];
    const all = await scanAll(async (key) => {
      seen.push(key);
      return pages[key ?? 'start']!;
    });
    expect(all).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([undefined, 'p2', 'p3']);
  });
});
