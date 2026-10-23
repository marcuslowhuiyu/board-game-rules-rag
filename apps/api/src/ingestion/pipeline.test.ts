import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  type BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  asContentId,
  asEditionId,
  asGameId,
  asIngestionJobId,
  asSourceDocumentId,
  IngestionJobSchema,
  type ContentPackage,
  type Game,
  type IngestionJob,
  type IngestionSourceRef,
} from '@bgr/domain';
import { sha256Hex, type ObjectStore, type PdfExtractor } from '@bgr/ingestion';
import { makeTestContext } from '../test-support.js';
import type { AppContext } from '../lib/context.js';
import {
  DynamoChunksRepository,
  PublishConflictError,
  type AtomicPublisher,
  type ChunksRepository,
  type IngestionJobsRepository,
  type InMemoryDocumentsRepository,
  type InMemoryGamesRepository,
  type InMemoryIngestionJobsRepository,
  InMemoryAtomicPublisher,
} from '@bgr/persistence';
import { RetryableStageError, runFullPipeline, runStage, StageError } from './pipeline.js';
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
  overrides: Partial<IngestionJob> = {},
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

  it('FETCH duplicate short-circuit marks the result terminal (state machine skips later stages)', async () => {
    const stageCtx = makeStageContext(ctx, {
      pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
    });
    const bytes = new Uint8Array([9, 9, 9]);
    const first = await createPdfJob(ctx, 'raw/first.pdf', bytes);
    await runFullPipeline(first.jobId, stageCtx);

    const second = await createPdfJob(ctx, 'raw/second.pdf', bytes);
    // Only run VALIDATE + FETCH; FETCH must return terminal:true and short-
    // circuit the rest of the pipeline (the state machine's Choice state
    // relies on this).
    await runStage(second.jobId, 'VALIDATE', stageCtx);
    const fetchResult = await runStage(second.jobId, 'FETCH', stageCtx);
    expect(fetchResult.terminal).toBe(true);
    expect(fetchResult.status).toBe('SUCCEEDED');
    expect(fetchResult.duplicate).toBe(true);
    expect(fetchResult.nextStage).toBeNull();
  });

  it('deduplicates only within the same contentId — identical bytes on a different content package publish a new document', async () => {
    await ctx.games.addContent({
      contentId: asContentId('c_promo'),
      gameId,
      editionId,
      slug: 'promo-pack',
      name: 'Promo Pack',
      contentType: 'PROMO',
      dependencies: [],
      status: 'READY',
    });
    const bytes = new Uint8Array([4, 4, 4]);
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });

    const baseJob = await createPdfJob(ctx, 'raw/base.pdf', bytes);
    const baseResult = await runFullPipeline(baseJob.jobId, stageCtx);

    const promoJob = await createPdfJob(ctx, 'raw/promo.pdf', bytes, {
      contentId: asContentId('c_promo'),
      title: 'Same PDF but for the promo',
    });
    const promoResult = await runFullPipeline(promoJob.jobId, stageCtx);

    expect(promoResult.job.documentId).not.toBe(baseResult.job.documentId);
    expect(promoResult.job.duplicateOf).toBeUndefined();
    const docs = await ctx.documents.listDocumentsForEdition(gameId, editionId);
    expect(docs.length).toBe(2);
    expect(new Set(docs.map((d) => d.contentId))).toEqual(new Set(['c_base', 'c_promo']));
  });

  it('quality gate: PARSE fails on likely-scan output (zero blocks, high empty ratio)', async () => {
    const emptyExtractor: PdfExtractor = { extract: async () => ({ pages: ['', '', ''] }) };
    const stageCtx = makeStageContext(ctx, { pdfExtractor: emptyExtractor });
    const job = await createPdfJob(ctx, 'raw/scan.pdf', new Uint8Array([1, 1, 1]));
    await expect(runFullPipeline(job.jobId, stageCtx)).rejects.toBeInstanceOf(StageError);
    const failed = await ctx.ingestionJobs.getJob(job.jobId);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.stage).toBe('PARSE');
    expect(failed?.qualityReport?.isLikelyScan).toBe(true);
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(0);
    expect(await ctx.documents.listDocumentsForEdition(gameId, editionId)).toEqual([]);
  });

  it('crash between CHUNK and FINALIZE: retry succeeds and does not misreport as duplicate', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/crash.pdf', new Uint8Array([2, 2, 2]));
    // Run every stage up to and including CHUNK; then simulate a crash
    // BEFORE FINALIZE by stopping here.
    for (const stage of [
      'VALIDATE',
      'FETCH',
      'PARSE',
      'CLASSIFY',
      'DISCOVER_ERRATA',
      'NORMALIZE',
      'CHUNK',
    ] as const) {
      await runStage(job.jobId, stage, stageCtx);
    }
    const afterChunk = await ctx.ingestionJobs.getJob(job.jobId);
    expect(afterChunk?.plannedDocumentId).toBeDefined();
    // No document is published yet.
    expect(await ctx.documents.listDocumentsForEdition(gameId, editionId)).toEqual([]);
    // Previous state unchanged.
    const gameBefore = await ctx.games.getGame(gameId);
    expect(gameBefore?.editions[0]?.knowledgeRevision).toBe(0);

    // Now run FINALIZE — should complete successfully.
    const finalize = await runStage(job.jobId, 'FINALIZE', stageCtx);
    expect(finalize.terminal).toBe(true);
    expect(finalize.duplicate).toBeUndefined();
    expect(finalize.status).toBe('SUCCEEDED');
    const gameAfter = await ctx.games.getGame(gameId);
    expect(gameAfter?.editions[0]?.knowledgeRevision).toBe(1);
  });

  it('defensive: a published document with a non-terminal job row recovers via plannedDocumentId', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/half.pdf', new Uint8Array([3, 3, 3]));
    // Advance to and including CHUNK; then run FINALIZE.
    for (const stage of [
      'VALIDATE',
      'FETCH',
      'PARSE',
      'CLASSIFY',
      'DISCOVER_ERRATA',
      'NORMALIZE',
      'CHUNK',
    ] as const) {
      await runStage(job.jobId, stage, stageCtx);
    }
    // The job write is inside the publish transaction, so this state can't
    // arise from a crash; simulate it (manual repair / legacy rows) by
    // clearing the job's SUCCEEDED marker after the publish landed.
    await runStage(job.jobId, 'FINALIZE', stageCtx);
    await ctx.ingestionJobs.updateJob(
      job.jobId,
      {
        status: 'RUNNING',
        stage: 'FINALIZE',
        documentId: undefined,
      },
      ctx.clock.now().toISOString(),
    );

    // Second FINALIZE — must recover, not mislabel as a duplicate.
    const retry = await runStage(job.jobId, 'FINALIZE', stageCtx);
    expect(retry.terminal).toBe(true);
    expect(retry.status).toBe('SUCCEEDED');
    // A recovery is NOT a duplicate (its `documentId` equals what the same
    // job planned — the state machine and UI should not label it as one).
    expect(retry.duplicate).toBeUndefined();
    // Revision was bumped exactly once — the retry did not double-bump.
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(1);
    const docs = await ctx.documents.listDocumentsForEdition(gameId, editionId);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.status).toBe('CURRENT');
  });

  it('stage runner is idempotent on already-terminal jobs (safe against Step Functions redelivery)', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/terminal.pdf', new Uint8Array([5, 5, 5]));
    const first = await runFullPipeline(job.jobId, stageCtx);
    expect(first.terminal).toBe(true);
    // Unexpected redelivery of any earlier stage must be a safe no-op.
    for (const s of ['VALIDATE', 'FETCH', 'CHUNK', 'FINALIZE'] as const) {
      const again = await runStage(job.jobId, s, stageCtx);
      expect(again.terminal).toBe(true);
      expect(again.alreadyTerminal).toBe(true);
      expect(again.status).toBe('SUCCEEDED');
    }
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(1);
    const docs = await ctx.documents.listDocumentsForEdition(gameId, editionId);
    expect(docs).toHaveLength(1);
  });

  async function runThroughChunk(jobId: string, stageCtx: ReturnType<typeof makeStageContext>) {
    for (const stage of [
      'VALIDATE',
      'FETCH',
      'PARSE',
      'CLASSIFY',
      'DISCOVER_ERRATA',
      'NORMALIZE',
      'CHUNK',
    ] as const) {
      await runStage(jobId, stage, stageCtx);
    }
  }

  function realPublisher(): InMemoryAtomicPublisher {
    return new InMemoryAtomicPublisher(
      ctx.documents as InMemoryDocumentsRepository,
      ctx.games as InMemoryGamesRepository,
      ctx.ingestionJobs as InMemoryIngestionJobsRepository,
    );
  }

  it('FINALIZE commits job SUCCEEDED with the publish: an error after commit does not mark it FAILED', async () => {
    const inner = realPublisher();
    // Transaction commits, then the call still throws (e.g. lost response).
    const publisher: AtomicPublisher = {
      publishDocument: async (args) => {
        await inner.publishDocument(args);
        throw new Error('socket hang up');
      },
    };
    const stageCtx = makeStageContext(ctx, {
      pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
      publisher,
    });
    const job = await createPdfJob(ctx, 'raw/lost.pdf', new Uint8Array([6, 6, 6]));
    await runThroughChunk(job.jobId, stageCtx);

    await expect(runStage(job.jobId, 'FINALIZE', stageCtx)).rejects.toThrow('socket hang up');
    const after = await ctx.ingestionJobs.getJob(job.jobId);
    expect(after?.status).toBe('SUCCEEDED');
    expect(after?.error).toBeUndefined();
    expect(after?.documentId).toBe(after?.plannedDocumentId);

    // A Step Functions retry of FINALIZE is a no-op and reports SUCCEEDED.
    const retry = await runStage(job.jobId, 'FINALIZE', stageCtx);
    expect(retry).toMatchObject({ terminal: true, alreadyTerminal: true, status: 'SUCCEEDED' });
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(1);
  });

  it('FINALIZE leaves no partial state when the publish transaction is rejected', async () => {
    const stageCtx = makeStageContext(ctx, {
      pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
      publisher: {
        publishDocument: async () => {
          throw new PublishConflictError('game moved', 'GAME_STALE');
        },
      },
    });
    const job = await createPdfJob(ctx, 'raw/reject.pdf', new Uint8Array([7, 7, 7]));
    await runThroughChunk(job.jobId, stageCtx);
    await expect(runStage(job.jobId, 'FINALIZE', stageCtx)).rejects.toThrow();
    expect(await ctx.documents.listDocumentsForEdition(gameId, editionId)).toEqual([]);
    const after = await ctx.ingestionJobs.getJob(job.jobId);
    expect(after?.status).toBe('RUNNING');
    expect(after?.documentId).toBeUndefined();
  });

  it.each(['GAME_STALE', 'PREV_NOT_CURRENT', 'JOB_STALE'] as const)(
    'FINALIZE %s conflict is retryable: job stays RUNNING and a retry publishes',
    async (reason) => {
      const inner = realPublisher();
      let calls = 0;
      const publisher: AtomicPublisher = {
        publishDocument: async (args) => {
          calls++;
          if (calls === 1) throw new PublishConflictError(`simulated ${reason}`, reason);
          await inner.publishDocument(args);
        },
      };
      const stageCtx = makeStageContext(ctx, {
        pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
        publisher,
      });
      const job = await createPdfJob(ctx, `raw/${reason}.pdf`, new Uint8Array([8, 8, 8]));
      await runThroughChunk(job.jobId, stageCtx);

      const err = await runStage(job.jobId, 'FINALIZE', stageCtx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryableStageError);
      // Lambda reports `name` as errorType; the state machine retries on it.
      expect((err as Error).name).toBe('RetryableStageError');
      expect((err as RetryableStageError).code).toBe(reason);
      const mid = await ctx.ingestionJobs.getJob(job.jobId);
      expect(mid?.status).toBe('RUNNING');
      expect(mid?.error).toBeUndefined();

      const retry = await runStage(job.jobId, 'FINALIZE', stageCtx);
      expect(retry.status).toBe('SUCCEEDED');
      expect(retry.terminal).toBe(true);
      const game = await ctx.games.getGame(gameId);
      expect(game?.editions[0]?.knowledgeRevision).toBe(1);
    },
  );

  it('real JOB_STALE: FINALIZE refuses to publish over a job row that moved', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/stale.pdf', new Uint8Array([9, 9, 9]));
    await runThroughChunk(job.jobId, stageCtx);
    const before = await ctx.ingestionJobs.getJob(job.jobId);
    // Another writer touches the job between FINALIZE's read and its publish.
    const racing: AtomicPublisher = {
      publishDocument: async (args) => {
        await ctx.ingestionJobs.updateJob(job.jobId, {}, '2026-09-17T01:00:00.000Z');
        await realPublisher().publishDocument(args);
      },
    };
    await expect(
      runStage(job.jobId, 'FINALIZE', { ...stageCtx, publisher: racing }),
    ).rejects.toBeInstanceOf(RetryableStageError);
    expect(before?.status).toBe('RUNNING');
    expect(await ctx.documents.listDocumentsForEdition(gameId, editionId)).toEqual([]);
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(0);
  });

  it('redelivery against an already-FAILED job reports terminal FAILED (state machine routes to MarkJobFailed)', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/failed.pdf', new Uint8Array([4, 4, 4]), {
      forceFailureStage: 'PARSE',
    });
    await expect(runFullPipeline(job.jobId, stageCtx)).rejects.toBeInstanceOf(StageError);
    const again = await runStage(job.jobId, 'CLASSIFY', stageCtx);
    expect(again).toMatchObject({ terminal: true, alreadyTerminal: true, status: 'FAILED' });
  });

  // -------------------------------------------------------------------------
  // M2-R2: CHUNK idempotency
  // -------------------------------------------------------------------------

  const BEFORE_CHUNK = [
    'VALIDATE',
    'FETCH',
    'PARSE',
    'CLASSIFY',
    'DISCOVER_ERRATA',
    'NORMALIZE',
  ] as const;
  const SMALL_CHUNKS = { minTokens: 20, targetTokens: 60, maxTokens: 120 };

  /**
   * Simulates the process dying mid-stage: the stage's own `failJob` write
   * never lands, so the job stays RUNNING and Step Functions may re-invoke
   * the stage.
   */
  function crashingJobs(inner: IngestionJobsRepository): IngestionJobsRepository {
    return {
      createJob: (j) => inner.createJob(j),
      getJob: (id) => inner.getJob(id),
      updateJob: (id, patch, at) => inner.updateJob(id, patch, at),
      markFailedIfActive: async () => {
        throw new Error('process died before failJob');
      },
    };
  }

  /** Records every key written; optionally throws on a chosen write. */
  function recordingStore(
    inner: ObjectStore,
    failWhen: (key: string) => boolean = () => false,
  ): ObjectStore & { keys: string[] } {
    const keys: string[] = [];
    return {
      keys,
      toUri: (k) => inner.toUri(k),
      getBytes: (u) => inner.getBytes(u),
      getText: (u) => inner.getText(u),
      putBytes: async (k, body, ct) => {
        if (failWhen(k)) throw new Error(`simulated crash writing ${k}`);
        keys.push(k);
        return inner.putBytes(k, body, ct);
      },
    };
  }

  it('CHUNK persists plannedDocumentId before any chunk write; a retry reuses it (no orphans)', async () => {
    let crashed = false;
    const store = recordingStore(ctx.normalizedStore, (k) => {
      if (!crashed && k.startsWith('normalized/')) {
        crashed = true;
        return true;
      }
      return false;
    });
    const base = makeStageContext(ctx, {
      pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
      chunkerOptions: SMALL_CHUNKS,
    });
    const stageCtx = { ...base, normalizedStore: store };
    const job = await createPdfJob(ctx, 'raw/r2a.pdf', new Uint8Array([1, 0, 1]));
    for (const s of BEFORE_CHUNK) await runStage(job.jobId, s, stageCtx);

    await expect(
      runStage(job.jobId, 'CHUNK', { ...stageCtx, jobs: crashingJobs(ctx.ingestionJobs) }),
    ).rejects.toThrow('simulated crash');
    const crashedJob = await ctx.ingestionJobs.getJob(job.jobId);
    expect(crashedJob?.status).toBe('RUNNING');
    const planned = crashedJob?.plannedDocumentId;
    expect(planned).toBeDefined();
    expect(await ctx.chunks.listChunksForDocument(planned!)).toEqual([]);

    await runStage(job.jobId, 'CHUNK', stageCtx);
    const afterRetry = await ctx.ingestionJobs.getJob(job.jobId);
    expect(afterRetry?.plannedDocumentId).toBe(planned);
    const chunkKeys = store.keys.filter((k) => k.startsWith('normalized/'));
    expect(chunkKeys.length).toBeGreaterThan(0);
    for (const k of chunkKeys) expect(k.startsWith(`normalized/${planned}/`)).toBe(true);

    const fin = await runStage(job.jobId, 'FINALIZE', stageCtx);
    expect(fin.status).toBe('SUCCEEDED');
    expect(fin.documentId).toBe(planned);
  });

  it('CHUNK crash between S3 body writes and DDB putChunks: retry rewrites the same keys and FINALIZE counts match', async () => {
    let failOnce = true;
    const chunks: ChunksRepository = {
      putChunks: async (c) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated crash before putChunks');
        }
        return ctx.chunks.putChunks(c);
      },
      listChunksForDocument: (id) => ctx.chunks.listChunksForDocument(id),
      deleteChunksForDocument: (id) => ctx.chunks.deleteChunksForDocument(id),
    };
    const store = recordingStore(ctx.normalizedStore);
    const base = makeStageContext(ctx, {
      pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
      chunkerOptions: SMALL_CHUNKS,
    });
    const stageCtx = { ...base, chunks, normalizedStore: store };
    const job = await createPdfJob(ctx, 'raw/r2b.pdf', new Uint8Array([1, 0, 2]));
    for (const s of BEFORE_CHUNK) await runStage(job.jobId, s, stageCtx);

    await expect(
      runStage(job.jobId, 'CHUNK', { ...stageCtx, jobs: crashingJobs(ctx.ingestionJobs) }),
    ).rejects.toThrow('simulated crash before putChunks');
    const firstKeys = store.keys.filter((k) => k.startsWith('normalized/'));
    expect(firstKeys.length).toBeGreaterThan(0);

    await runStage(job.jobId, 'CHUNK', stageCtx);
    const allKeys = store.keys.filter((k) => k.startsWith('normalized/'));
    // Second attempt wrote exactly the same keys again — overwrite, not orphan.
    expect(allKeys.slice(firstKeys.length)).toEqual(firstKeys);

    const fin = await runStage(job.jobId, 'FINALIZE', stageCtx);
    expect(fin.status).toBe('SUCCEEDED');
    expect(fin.chunkCount).toBe(firstKeys.length);
  });

  it('CHUNK against DynamoDB with UnprocessedItems: the R6 retry loop persists every chunk and FINALIZE counts match', async () => {
    const table = new Map<string, Record<string, unknown>>();
    let batchCalls = 0;
    const docMock = mockClient(DynamoDBDocumentClient);
    try {
      docMock.on(BatchWriteCommand).callsFake((input: BatchWriteCommandInput) => {
        batchCalls++;
        const reqs = input.RequestItems!['chunks']!;
        // First call: DynamoDB accepts only the first half.
        const accepted = batchCalls === 1 ? reqs.slice(0, Math.ceil(reqs.length / 2)) : reqs;
        for (const r of accepted) {
          const item = r.PutRequest!.Item as Record<string, unknown>;
          table.set(item['chunkId'] as string, item);
        }
        const rest = reqs.slice(accepted.length);
        return rest.length > 0 ? { UnprocessedItems: { chunks: rest } } : {};
      });
      docMock.on(QueryCommand).callsFake((input) => ({
        Items: [...table.values()].filter(
          (i) => i['documentId'] === input.ExpressionAttributeValues[':d'],
        ),
      }));
      const chunks = new DynamoChunksRepository(
        new DynamoDBClient({ region: 'ap-southeast-1' }),
        { chunksTable: 'chunks' },
        { sleep: async () => {}, jitter: () => 0 },
      );
      const base = makeStageContext(ctx, {
        pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES),
        chunkerOptions: SMALL_CHUNKS,
      });
      const stageCtx = { ...base, chunks };
      const job = await createPdfJob(ctx, 'raw/r2c.pdf', new Uint8Array([1, 0, 3]));
      for (const s of BEFORE_CHUNK) await runStage(job.jobId, s, stageCtx);

      const chunk = await runStage(job.jobId, 'CHUNK', stageCtx);
      expect(chunk.chunkCount).toBeGreaterThan(1);
      expect(batchCalls).toBeGreaterThan(1);
      expect(table.size).toBe(chunk.chunkCount);

      const fin = await runStage(job.jobId, 'FINALIZE', stageCtx);
      expect(fin.status).toBe('SUCCEEDED');
      expect(fin.chunkCount).toBe(table.size);
    } finally {
      docMock.restore();
    }
  });

  it('SourceDocument.pageCount is the parser page count, not max(chunk.pageEnd), when the last page is empty', async () => {
    const pages = [...RULEBOOK_V2_PAGES, ''];
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(pages) });
    const job = await createPdfJob(ctx, 'raw/r2-pages.pdf', new Uint8Array([1, 0, 4]));
    const result = await runFullPipeline(job.jobId, stageCtx);
    expect(result.status).toBe('SUCCEEDED');
    const doc = await ctx.documents.getDocument(asSourceDocumentId(result.documentId!));
    const chunks = await ctx.chunks.listChunksForDocument(asSourceDocumentId(result.documentId!));
    expect(Math.max(...chunks.map((c) => c.pageEnd))).toBe(pages.length - 1);
    expect(doc?.pageCount).toBe(pages.length);
  });

  it('chunks carry no isCurrent flag (currency comes from SourceDocument.status)', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/r2-cur.pdf', new Uint8Array([1, 0, 5]));
    const result = await runFullPipeline(job.jobId, stageCtx);
    const chunks = await ctx.chunks.listChunksForDocument(asSourceDocumentId(result.documentId!));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect('isCurrent' in c).toBe(false);
  });

  it('failJob does not downgrade a job that SUCCEEDED after the stage read it', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/race.pdf', new Uint8Array([1, 2, 9]), {
      forceFailureStage: 'PARSE',
    });
    // Real row: SUCCEEDED. Reads: a stale RUNNING snapshot at PARSE.
    await ctx.ingestionJobs.updateJob(job.jobId, { status: 'SUCCEEDED' }, NOW);
    const stale = { ...job, status: 'RUNNING' as const, stage: 'PARSE' as const };
    const racingJobs: IngestionJobsRepository = Object.assign(Object.create(ctx.ingestionJobs), {
      getJob: async () => stale,
    });

    await expect(runStage(job.jobId, 'PARSE', { ...stageCtx, jobs: racingJobs })).rejects.toThrow(
      'forced failure',
    );
    const after = await ctx.ingestionJobs.getJob(job.jobId);
    expect(after?.status).toBe('SUCCEEDED');
    expect(after?.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // M2-R3: format-appropriate quality gate
  // -------------------------------------------------------------------------

  async function createHtmlJob(html: string, url: string) {
    const fetched = {
      bytes: new TextEncoder().encode(html),
      contentType: 'text/html; charset=utf-8',
      canonicalUrl: url,
    };
    const stageCtx = makeStageContext(ctx, { urlFetcher: { fetch: async () => fetched } });
    const nowIso = ctx.clock.now().toISOString();
    const job = IngestionJobSchema.parse({
      jobId: asIngestionJobId(ctx.ids.ingestionJobId()),
      gameId,
      editionId,
      contentId,
      title: 'Living Rules',
      sourceType: 'LIVING_RULES',
      authority: 'OFFICIAL_RULES',
      source: { kind: 'URL', url },
      status: 'PENDING',
      stage: 'VALIDATE',
      completedStages: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await ctx.ingestionJobs.createJob(job);
    return { job, stageCtx };
  }

  async function expectParseFailure(jobId: string, code: string) {
    const failed = await ctx.ingestionJobs.getJob(asIngestionJobId(jobId));
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toMatchObject({ stage: 'PARSE', code });
    expect(await ctx.documents.listDocumentsForEdition(gameId, editionId)).toEqual([]);
    const game = await ctx.games.getGame(gameId);
    expect(game?.editions[0]?.knowledgeRevision).toBe(0);
  }

  it('rejects a PDF whose text layer is mostly replacement characters (GARBLED_EXTRACTION)', async () => {
    // Two healthy pages plus one page of U+FFFD: enough text per page that
    // the scan and empty-page gates both pass.
    const pages = [...RULEBOOK_V1_PAGES, '�'.repeat(600)];
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(pages) });
    const job = await createPdfJob(ctx, 'raw/garbled.pdf', new Uint8Array([3, 0, 1]));
    await expect(runFullPipeline(job.jobId, stageCtx)).rejects.toBeInstanceOf(StageError);
    await expectParseFailure(job.jobId, 'GARBLED_EXTRACTION');
  });

  it('rejects garbled HTML too (GARBLED_EXTRACTION)', async () => {
    const { job, stageCtx } = await createHtmlJob(
      `<html><body><main><h1>Rules</h1><p>${'�'.repeat(300)} Draw two cards.</p></main></body></html>`,
      'https://publisher.example.com/garbled',
    );
    await expect(runFullPipeline(job.jobId, stageCtx)).rejects.toBeInstanceOf(StageError);
    await expectParseFailure(job.jobId, 'GARBLED_EXTRACTION');
  });

  it('accepts a short but valid HTML rules page (scan detection is PDF-only)', async () => {
    const { job, stageCtx } = await createHtmlJob(
      '<html><body><main><p>Draw two cards.</p></main></body></html>',
      'https://publisher.example.com/short',
    );
    const result = await runFullPipeline(job.jobId, stageCtx);
    expect(result.status).toBe('SUCCEEDED');
  });

  it('still rejects a PDF with too little text per page as a likely scan', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(['Draw two cards.']) });
    const job = await createPdfJob(ctx, 'raw/short.pdf', new Uint8Array([3, 0, 2]));
    await expect(runFullPipeline(job.jobId, stageCtx)).rejects.toBeInstanceOf(StageError);
    await expectParseFailure(job.jobId, 'LIKELY_SCAN');
  });

  it('re-uploading a SUPERSEDED version reinstates it as CURRENT and bumps knowledgeRevision', async () => {
    const v1Bytes = new Uint8Array([1, 1, 1]);
    const one = await runFullPipeline(
      (await createPdfJob(ctx, 'raw/v1.pdf', v1Bytes)).jobId,
      makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) }),
    );
    const two = await runFullPipeline(
      (await createPdfJob(ctx, 'raw/v2.pdf', new Uint8Array([2, 2, 2]))).jobId,
      makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V2_PAGES) }),
    );
    const v1Id = asSourceDocumentId(one.job.documentId!);
    const v2Id = asSourceDocumentId(two.job.documentId!);
    const v1ChunkCount = (await ctx.documents.getDocument(v1Id))!.chunkCount;

    const three = await runFullPipeline(
      (await createPdfJob(ctx, 'raw/v1-again.pdf', v1Bytes)).jobId,
      makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) }),
    );

    expect(three.job.status).toBe('SUCCEEDED');
    expect(three.duplicate).toBeFalsy();
    expect(three.job.duplicateOf).toBeUndefined();
    expect(three.job.documentId).toBe(v1Id);
    expect(three.job.supersededDocumentId).toBe(v2Id);
    expect(three.job.chunkCount).toBe(v1ChunkCount);
    const v1 = await ctx.documents.getDocument(v1Id);
    expect(v1?.status).toBe('CURRENT');
    expect(v1?.knowledgeRevision).toBe(3);
    expect(v1?.supersedes).toContain(v2Id);
    expect((await ctx.documents.getDocument(v2Id))?.status).toBe('SUPERSEDED');
    expect((await ctx.games.getGame(gameId))!.editions[0]!.knowledgeRevision).toBe(3);
    expect(await ctx.documents.listDocumentsForEdition(gameId, editionId)).toHaveLength(2);
  });

  it('reinstate retries (never FAILS) when another job reinstated the same document first', async () => {
    const v1Bytes = new Uint8Array([5, 1, 5]);
    const one = await runFullPipeline(
      (await createPdfJob(ctx, 'raw/r1.pdf', v1Bytes)).jobId,
      makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) }),
    );
    await runFullPipeline(
      (await createPdfJob(ctx, 'raw/r2.pdf', new Uint8Array([5, 2, 5]))).jobId,
      makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V2_PAGES) }),
    );
    const v1Id = asSourceDocumentId(one.job.documentId!);
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const job = await createPdfJob(ctx, 'raw/r1-again.pdf', v1Bytes);
    for (const stage of ['VALIDATE', 'FETCH'] as const) await runStage(job.jobId, stage, stageCtx);

    // Race: after FINALIZE's dedup lookup saw v1 SUPERSEDED, another job
    // reinstated it — so the CURRENT document for the key is v1 itself.
    const docs = ctx.documents as InMemoryDocumentsRepository;
    const findCurrent = docs.findCurrentByKey.bind(docs);
    docs.findCurrentByKey = async () => ({
      ...(await docs.getDocument(v1Id))!,
      status: 'CURRENT' as const,
    });
    const err = await runStage(job.jobId, 'FINALIZE', stageCtx).catch((e: unknown) => e);
    docs.findCurrentByKey = findCurrent;

    expect(err).toBeInstanceOf(RetryableStageError);
    expect((await ctx.ingestionJobs.getJob(job.jobId))?.status).toBe('RUNNING');
  });

  it('parses and retains the uploaded bytes FETCH hashed, even if the upload key is overwritten later', async () => {
    const original = new Uint8Array([7, 7, 7, 7]);
    const seen: Uint8Array[] = [];
    const stageCtx = makeStageContext(ctx, {
      pdfExtractor: {
        extract: async (bytes) => {
          seen.push(bytes);
          return { pages: RULEBOOK_V1_PAGES };
        },
      },
    });
    const job = await createPdfJob(ctx, 'raw/reused.pdf', original);
    await runStage(job.jobId, 'VALIDATE', stageCtx);
    await runStage(job.jobId, 'FETCH', stageCtx);
    // The presigned PUT URL is still valid: someone re-uploads to the same key.
    await ctx.rawStore.putBytes('raw/reused.pdf', new Uint8Array([6, 6]), 'application/pdf');

    const result = await runFullPipeline(job.jobId, stageCtx);

    expect(result.status).toBe('SUCCEEDED');
    expect(Array.from(seen[0]!)).toEqual(Array.from(original));
    const doc = await ctx.documents.getDocument(asSourceDocumentId(result.job.documentId!));
    expect(doc?.contentHash).toBe(sha256Hex(original));
    expect(Array.from(await ctx.rawStore.getBytes(doc!.rawObjectUri))).toEqual(
      Array.from(original),
    );
  });

  it('two concurrent jobs with identical bytes publish once (game read precedes the FINALIZE dedup lookup)', async () => {
    const stageCtx = makeStageContext(ctx, { pdfExtractor: makeExtractor(RULEBOOK_V1_PAGES) });
    const bytes = new Uint8Array([4, 4, 4]);
    const a = await createPdfJob(ctx, 'raw/a.pdf', bytes);
    const b = await createPdfJob(ctx, 'raw/b.pdf', bytes);
    const upToChunk = [
      'VALIDATE',
      'FETCH',
      'PARSE',
      'CLASSIFY',
      'DISCOVER_ERRATA',
      'NORMALIZE',
      'CHUNK',
    ] as const;
    for (const stage of upToChunk) {
      await runStage(a.jobId, stage, stageCtx);
      await runStage(b.jobId, stage, stageCtx);
    }

    // Interleave: B's FINALIZE dedup lookup misses, then A publishes in full,
    // then B carries on.
    const docs = ctx.documents as InMemoryDocumentsRepository;
    const lookup = docs.findByContentHash.bind(docs);
    let interleaved = false;
    docs.findByContentHash = async (...args) => {
      const found = await lookup(...args);
      if (!interleaved) {
        interleaved = true;
        await runStage(a.jobId, 'FINALIZE', stageCtx);
      }
      return found;
    };
    const firstAttempt = await runStage(b.jobId, 'FINALIZE', stageCtx).catch((e: unknown) => e);
    docs.findByContentHash = lookup;
    if (firstAttempt instanceof RetryableStageError) {
      await runStage(b.jobId, 'FINALIZE', stageCtx); // the state machine's retry
    }

    const published = await ctx.documents.listDocumentsForEdition(gameId, editionId);
    expect(published).toHaveLength(1);
    expect((await ctx.games.getGame(gameId))!.editions[0]!.knowledgeRevision).toBe(1);
    const jobB = await ctx.ingestionJobs.getJob(b.jobId);
    expect(jobB?.status).toBe('SUCCEEDED');
    expect(jobB?.duplicateOf).toBe(published[0]!.documentId);
  });
});
