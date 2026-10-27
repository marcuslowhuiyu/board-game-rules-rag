/**
 * PR regression subset: the eval pipeline end to end over an invented game,
 * with the real VectorRulesRetriever, an in-memory index and a deterministic
 * hash embedder. No AWS, no network. It guards scoring and the retriever's
 * filtering, not embedding quality.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SourceDocumentSchema, type SourceDocument } from '@bgr/domain';
import { InMemoryDocumentsRepository } from '@bgr/persistence';
import {
  InMemoryVectorIndex,
  VectorRulesRetriever,
  type RetrievalQuery,
  type RetrievedChunk,
  type RulesRetriever,
} from '@bgr/retrieval';
import { describe, expect, it } from 'vitest';
import { loadDataset } from './dataset/case-schema.js';
import type { EvalConfig } from './scoring/aggregate.js';
import { EvalConfigError, resolveLiveGames, runEval, type EvalGames } from './run-eval.js';
import { HashEmbedder } from './testing/hash-embedder.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/retrieval/${name}`, import.meta.url));

interface Corpus {
  game: { key: string; gameId: string; editionId: string; content: Record<string, string> };
  documents: Array<
    Pick<SourceDocument, 'documentId' | 'contentId' | 'status' | 'sourceType' | 'authority'>
  >;
  chunks: Array<{ chunkId: string; documentId: string; headingPath: string[]; text: string }>;
}

// The subset's corpus is tiny by design, so nothing is excluded as a small corpus here.
const config: EvalConfig = {
  topK: 15,
  smallCorpusThreshold: 0,
  bars: { simple: { k: 3, minRate: 0.9 }, complex: { k: 10, minRate: 0.7 } },
};

async function setup() {
  const corpus = JSON.parse(await readFile(fixture('synthetic-corpus.json'), 'utf8')) as Corpus;
  const { gameId, editionId } = corpus.game;
  const documents = new InMemoryDocumentsRepository();
  for (const d of corpus.documents) {
    documents.putDocument(
      SourceDocumentSchema.parse({
        ...d,
        gameId,
        editionId,
        title: d.documentId,
        origin: 'UPLOAD',
        contentHash: 'a'.repeat(64),
        rawObjectUri: `s3://fixture/${d.documentId}`,
        chunkCount: 0,
        supersedes: [],
        knowledgeRevision: 1,
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
      }),
    );
  }
  const embeddings = new HashEmbedder();
  const index = new InMemoryVectorIndex();
  const { vectors } = await embeddings.embed(corpus.chunks.map((c) => c.text));
  await index.putVectors(
    corpus.chunks.map((c, i) => {
      const doc = corpus.documents.find((d) => d.documentId === c.documentId)!;
      return {
        key: c.chunkId,
        vector: vectors[i]!,
        metadata: {
          gameId,
          editionId,
          contentId: doc.contentId,
          documentId: c.documentId,
          authority: doc.authority,
          sourceType: doc.sourceType,
          headingPath: c.headingPath,
          pageStart: 1,
          pageEnd: 1,
          text: c.text,
        },
      };
    }),
  );
  const seen: RetrievedChunk[] = [];
  const inner = new VectorRulesRetriever({ embeddings, index, documents, topK: config.topK });
  const retriever: RulesRetriever & { calls: number } = {
    calls: 0,
    async retrieve(q: RetrievalQuery) {
      retriever.calls++;
      const out = await inner.retrieve(q);
      seen.push(...out);
      return out;
    },
  };
  const games: EvalGames = {
    [corpus.game.key]: {
      gameId,
      editionId,
      content: { base: corpus.game.content['base']! },
      chunks: corpus.chunks.length,
    },
  };
  const cases = await loadDataset([fixture('synthetic-cases.jsonl')]);
  return { cases, games, retriever, seen, documents };
}

describe('retrieval regression subset', () => {
  it('meets both bars on the synthetic corpus', async () => {
    const { cases, games, retriever } = await setup();
    const report = await runEval({ cases, games, retriever, config });
    expect(report.tiers.simple.cases).toBe(4);
    expect(report.tiers.complex.cases).toBe(2);
    expect(report.tiers.simple.passed).toBe(true);
    expect(report.tiers.complex.passed).toBe(true);
  });

  it('never returns superseded or disabled-promo chunks', async () => {
    const { cases, games, retriever, seen } = await setup();
    await runEval({ cases, games, retriever, config });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.map((c) => c.documentId)).not.toContain('doc_starfall_rules_v1');
    expect(seen.map((c) => c.contentId)).not.toContain('c_starfall_promo');
  });

  it('unknown game fails fast before querying', async () => {
    const { cases, games, retriever } = await setup();
    const bad = [...cases, { ...cases[0]!, id: 'ghost', game: 'ghost-game' }];
    await expect(runEval({ cases: bad, games, retriever, config })).rejects.toThrow(
      new EvalConfigError('unknown game "ghost-game" in case ghost'),
    );
    expect(retriever.calls).toBe(0);
  });

  it('unknown content slug fails fast before querying', async () => {
    const { cases, games, retriever } = await setup();
    const bad = [{ ...cases[0]!, id: 'promo', enabledContent: ['base', 'promo'] }];
    await expect(runEval({ cases: bad, games, retriever, config })).rejects.toThrow(
      /unknown content "promo" for game "starfall" in case promo/,
    );
    expect(retriever.calls).toBe(0);
  });
});

describe('HashEmbedder', () => {
  it('is deterministic and unit length', async () => {
    const e = new HashEmbedder();
    const a = await e.embed(['Launch a scout ship', 'launch a SCOUT ship!']);
    expect(a.vectors[0]).toEqual(a.vectors[1]);
    expect(a.vectors[0]).toHaveLength(256);
    const norm = Math.sqrt(a.vectors[0]!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1);
  });
});

describe('resolveLiveGames', () => {
  it('replaces the chunk snapshot with the live count of CURRENT documents in referenced content', async () => {
    const { cases, games, documents } = await setup();
    for (const d of await documents.listDocumentsForEdition(
      games['starfall']!.gameId as never,
      games['starfall']!.editionId as never,
    )) {
      documents.putDocument({ ...d, chunkCount: 10 });
    }
    const live = await resolveLiveGames(
      cases,
      { ...games, starfall: { ...games['starfall']!, chunks: 1 } },
      documents,
    );
    // rules v2 + FAQ are CURRENT base documents; v1 is superseded and promo is not enabled.
    expect(live['starfall']!.chunks).toBe(20);
  });

  it('fails when a referenced game has no CURRENT documents (deleted or re-created)', async () => {
    const { cases, games, documents } = await setup();
    const stale = { starfall: { ...games['starfall']!, editionId: 'e_gone' } };
    await expect(resolveLiveGames(cases, stale, documents)).rejects.toThrow(
      new EvalConfigError(
        'game "starfall" (g_starfall / e_gone) has no CURRENT documents in content base; re-run eval:ingest',
      ),
    );
  });
});
