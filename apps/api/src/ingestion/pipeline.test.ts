import { beforeEach, describe, expect, it } from 'vitest';
import {
  asContentId,
  asEditionId,
  asGameId,
  asIngestionJobId,
  asSourceDocumentId,
  IngestionJobSchema,
  type ContentPackage,
  type CreateIngestionJobInput,
  type Game,
  type IngestionJob,
  type IngestionSourceRef,
} from '@bgr/domain';
import { sha256Hex, type PdfExtractor } from '@bgr/ingestion';
import { makeTestContext } from '../test-support.js';
import type { AppContext } from '../lib/context.js';
import { runFullPipeline, runStage, StageError } from './pipeline.js';
import { makeStageContext, sequentialIds } from './test-support.js';

const NOW = '2026-09-17T00:00:00.000Z';

const gameId = asGameId('g_ti4');
const editionId = asEditionId('e_1');
const contentId = asContentId('c_base');

const RULEBOOK_V1_PAGES = [
  `TWILIGHT IMPERIUM\n\nRules Reference\n\n1. OVERVIEW\n\nThis document is the authoritative rules reference for Twilight Imperium Fourth Edition. It describes every rule in exhaustive detail. Use it as the source of truth. The base game rules apply always.`,
  `2. COMBAT\n\nCombat resolves in rounds. Each round each participating player rolls dice for every unit engaged.\n\n2.1 Assign Hits\n\nThe attacker assigns hits produced by their own units. Each unit takes one hit before another may be assigned. Sustain damage abilities may absorb the first hit.`,
];

const RULEBOOK_V2_PAGES = [
  ...RULEBOOK_V1_PAGES,
  `3. ERRATA\n\nSection 2.1 clarified: sustain damage may be applied AFTER hits are assigned. This changes the ordering.`,
];

const makeExtractor = (pages: string[]): PdfExtractor => ({
  extract: async () => ({ pages }),
});

async function seed(ctx: AppContext) {
  const game: Game = {
    gameId,
    slug: 'twilight-imperium-4',
    name: 'Twilight Imperium 4',
    editions: [
      {
        editionId,
        gameId,
        name: '4th Edition',
        knowledgeRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.games.createGame(game);
  const content: ContentPackage = {
    contentId,
    gameId,
    editionId,
    slug: 'base',
    name: 'Base Game',
    contentType: 'BASE',
    dependencies: [],
    status: 'READY',
  };
  await ctx.games.addContent(content);
}

async function createPdfJob(
  ctx: AppContext,
  s3Key: string,
  bytes: Uint8Array,
  overrides: Partial<CreateIngestionJobInput> = {},
): Promise<IngestionJob> {
  await ctx.rawStore.putBytes(s3Key, bytes, 'application/pdf');
  const source: IngestionSourceRef = {
    kind: 'S3',
    s3Key,
    contentType: 'application/pdf',
  };
  const nowIso = ctx.clock.now().toISOString();
  const jobId = asIngestionJobId(ctx.ids.ingestionJobId());
  const job: IngestionJob = IngestionJobSchema.parse({
    jobId,
    gameId,
    editionId,
    contentId,
    title: 'Base Rulebook',
    sourceType: 'RULEBOOK',
    authority: 'OFFICIAL_RULES',
    source,
    status: 'PENDING',
    stage: 'VALIDATE',
    completedStages: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  });
  await ctx.ingestionJobs.createJob(job);
  return job;
}

describe('ingestion pipeline (M2 acceptance)', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = makeTestContext({ ids: sequentialIds() });
    await seed(ctx);
  });

  it('parses a rulebook PDF and produces chunks with heading paths + page ranges', async () => {
    const stageCtx = makeStageContext(ctx, {
      pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
      chunkerOptions: { minTokens: 20, targetTokens: 60, maxTokens: 120 },
    });
    const job = await createPdfJob(ctx, 'raw/v1.pdf', new Uint8Array([1, 2, 3]));

    const result = await runFullPipeline(job.jobId, stageCtx);
    expect(result.job.status).toBe('SUCCEEDED');
    expect(result.job.documentId).toBeDefined();
    expect(result.chunkCount).toBeGreaterThan(0);

    const chunks = await ctx.chunks.listChunksForDocument(
      asSourceDocumentId(result.job.documentId!),
    );
    expect(chunks.length).toBeGreaterThan(0);
    const assignHits = chunks.find((c) => c.headingPath.includes('2.1 Assign Hits'));
    expect(assignHits).toBeDefined();
    expect(assignHits!.pageStart).toBe(2);
    expect(assignHits!.textUri).toMatch(/^mem:\/\/test-bucket\/normalized\//);
    expect(assignHits!.textPreview).toContain('attacker assigns hits');
  });

  it('does not create a second document when the same PDF is uploaded twice', async () => {
    const stageCtx = makeStageContext(ctx, {
      pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
    });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const first = await createPdfJob(ctx, 'raw/dup1.pdf', bytes);
    const one = await runFullPipeline(first.jobId, stageCtx);
    const firstDoc = one.job.documentId!;

    const beforeRev = (await ctx.games.getGame(gameId))!.editions[0]!.knowledgeRevision;

    // Second upload, same bytes → new S3 key but same hash.
    const second = await createPdfJob(ctx, 'raw/dup2.pdf', bytes);
    const two = await runFullPipeline(second.jobId, stageCtx);
    expect(two.job.status).toBe('SUCCEEDED');
    expect(two.job.documentId).toBe(firstDoc);
    expect(two.duplicate).toBe(true);

    const afterRev = (await ctx.games.getGame(gameId))!.editions[0]!.knowledgeRevision;
    expect(afterRev).toBe(beforeRev);
  });

  it('marks the previous CURRENT document SUPERSEDED and bumps knowledgeRevision on a new version', async () => {
    const v1Extractor = makeExtractor(RULEBOOK_V1_PAGES);
    const v2Extractor = makeExtractor(RULEBOOK_V2_PAGES);
    // v1 upload
    const first = await createPdfJob(ctx, 'raw/v1.pdf', new Uint8Array([1, 2, 3]));
    const one = await runFullPipeline(
      first.jobId,
      makeStageContext(ctx, { pdfExtractor: v1Extractor }),
    );
    const v1Id = asSourceDocumentId(one.job.documentId!);
    expect((await ctx.documents.getDocument(v1Id))?.status).toBe('CURRENT');
    const rev1 = (await ctx.games.getGame(gameId))!.editions[0]!.knowledgeRevision;
    expect(rev1).toBe(1);

    // v2 upload — different bytes
    const second = await createPdfJob(ctx, 'raw/v2.pdf', new Uint8Array([9, 9, 9, 9]));
    const two = await runFullPipeline(
      second.jobId,
      makeStageContext(ctx, { pdfExtractor: v2Extractor }),
    );
    const v2Id = asSourceDocumentId(two.job.documentId!);
    expect(v2Id).not.toBe(v1Id);
    const rev2 = (await ctx.games.getGame(gameId))!.editions[0]!.knowledgeRevision;
    expect(rev2).toBe(2);
    const v1After = await ctx.documents.getDocument(v1Id);
    expect(v1After?.status).toBe('SUPERSEDED');
    const v2After = await ctx.documents.getDocument(v2Id);
    expect(v2After?.status).toBe('CURRENT');
    expect(v2After?.supersedes).toContain(v1Id);
  });

  it('ingests a living-rules HTML URL with heading paths preserved', async () => {
    const html = `<html><body><main>
      <h1>Living Rules</h1>
      <h2>Combat</h2>
      <p>Combat proceeds in rounds.</p>
      <h3>Assign Hits</h3>
      <p>The attacker assigns hits.</p>
    </main></body></html>`;
    const fetched = {
      bytes: new TextEncoder().encode(html),
      contentType: 'text/html; charset=utf-8',
      canonicalUrl: 'https://publisher.example.com/living-rules',
    };
    const stageCtx = makeStageContext(ctx, {
      urlFetcher: { fetch: async () => fetched },
    });
    const jobId = asIngestionJobId(ctx.ids.ingestionJobId());
    const nowIso = ctx.clock.now().toISOString();
    const job = IngestionJobSchema.parse({
      jobId,
      gameId,
      editionId,
      contentId,
      title: 'Living Rules',
      sourceType: 'LIVING_RULES',
      authority: 'OFFICIAL_RULES',
      source: { kind: 'URL', url: 'https://publisher.example.com/living-rules' },
      status: 'PENDING',
      stage: 'VALIDATE',
      completedStages: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await ctx.ingestionJobs.createJob(job);

    const result = await runFullPipeline(job.jobId, stageCtx);
    expect(result.job.status).toBe('SUCCEEDED');
    const doc = await ctx.documents.getDocument(asSourceDocumentId(result.job.documentId!));
    expect(doc?.canonicalUrl).toBe('https://publisher.example.com/living-rules');
    expect(doc?.publisherDomain).toBe('publisher.example.com');
    expect(doc?.origin).toBe('URL');

    const chunks = await ctx.chunks.listChunksForDocument(
      asSourceDocumentId(result.job.documentId!),
    );
    const hit = chunks.find((c) => c.headingPath.includes('Assign Hits'));
    expect(hit).toBeDefined();
    // The raw URL snapshot lives in the raw store keyed by content hash.
    const hash = sha256Hex(fetched.bytes);
    const uri = ctx.rawStore.toUri(`raw/url/${hash}.snapshot`);
    const snapshot = await ctx.rawStore.getText(uri);
    expect(snapshot).toContain('Living Rules');
  });

  it('rejects a URL that resolves to a private IP (SSRF)', async () => {
    // Assemble a URL fetcher that goes through the real SSRF guard by
    // injecting a resolver that returns 169.254.169.254 (EC2 metadata).
    const stageCtx = makeStageContext(ctx, {
      urlFetcher: {
        async fetch(source) {
          if (source.kind !== 'URL') throw new Error('unreachable');
          const { assertUrlSafeForFetch } = await import('@bgr/ingestion');
          await assertUrlSafeForFetch(source.url, {
            resolveDns: async () => [{ address: '169.254.169.254' }],
          });
          throw new Error('unreachable — should have rejected');
        },
      },
    });
    const jobId = asIngestionJobId(ctx.ids.ingestionJobId());
    const nowIso = ctx.clock.now().toISOString();
    await ctx.ingestionJobs.createJob(
      IngestionJobSchema.parse({
        jobId,
        gameId,
        editionId,
        contentId,
        title: 'Sneaky',
        sourceType: 'LIVING_RULES',
        authority: 'OFFICIAL_RULES',
        source: { kind: 'URL', url: 'https://sneaky.example.com/meta' },
        status: 'PENDING',
        stage: 'VALIDATE',
        completedStages: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    );
    await runStage(jobId, 'VALIDATE', stageCtx);
    await expect(runStage(jobId, 'FETCH', stageCtx)).rejects.toBeInstanceOf(StageError);
    const failed = await ctx.ingestionJobs.getJob(jobId);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.stage).toBe('FETCH');
    // Game unchanged.
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(0);
    // No document created.
    const docs = await ctx.documents.listDocumentsForEdition(gameId, editionId);
    expect(docs).toEqual([]);
  });

  it('leaves the job FAILED and the game unchanged when NORMALIZE is forced to fail', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/force.pdf', new Uint8Array([1, 2, 3]), {
      forceFailureStage: 'NORMALIZE',
    });
    await expect(runFullPipeline(job.jobId, stageCtx)).rejects.toBeInstanceOf(StageError);
    const failed = await ctx.ingestionJobs.getJob(job.jobId);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.stage).toBe('NORMALIZE');
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(0);
    expect(await ctx.documents.listDocumentsForEdition(gameId, editionId)).toEqual([]);
  });

  it('records each completed stage on the job', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/stages.pdf', new Uint8Array([7, 7, 7]));
    const result = await runFullPipeline(job.jobId, stageCtx);
    expect(result.job.completedStages).toEqual([
      'VALIDATE',
      'FETCH',
      'PARSE',
      'CLASSIFY',
      'DISCOVER_ERRATA',
      'NORMALIZE',
      'CHUNK',
      'FINALIZE',
    ]);
  });
});
