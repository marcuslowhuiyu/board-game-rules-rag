import {
  ChunkSchema,
  IngestionJobSchema,
  SourceDocumentSchema,
  asChunkId,
  asIngestionJobId,
  asSourceDocumentId,
  type Chunk,
  type ContentId,
  type EditionId,
  type GameId,
  type IngestionJob,
  type IngestionJobId,
  type IngestionStage,
  type SourceDocument,
  type SourceType,
} from '@bgr/domain';
import type { Logger } from '@bgr/shared';
import type {
  ChunksRepository,
  DocumentsRepository,
  GamesRepository,
  IdGenerator,
  IngestionJobsRepository,
} from '@bgr/persistence';
import {
  classifySource,
  chunkDocument,
  createHtmlParser,
  sha256Hex,
  type ChunkerOptions,
  type DocumentFetcher,
  type DocumentParser,
  type ObjectStore,
  type ParsedDocument,
} from '@bgr/ingestion';

export interface StageContext {
  now: () => Date;
  ids: IdGenerator;
  documents: DocumentsRepository;
  chunks: ChunksRepository;
  jobs: IngestionJobsRepository;
  games: GamesRepository;
  /** Raw source bytes bucket (`raw/…`). */
  rawStore: ObjectStore;
  /** Parsed/normalized/chunk text bucket (`normalized/…`). */
  normalizedStore: ObjectStore;
  urlFetcher: DocumentFetcher;
  s3Fetcher: DocumentFetcher;
  pdfParser: DocumentParser;
  htmlParser: DocumentParser;
  chunkerOptions?: ChunkerOptions;
  logger?: Logger;
}

/** Ordered list of stages that actually run in M2. */
export const M2_STAGE_ORDER: IngestionStage[] = [
  'VALIDATE',
  'FETCH',
  'PARSE',
  'CLASSIFY',
  'DISCOVER_ERRATA',
  'NORMALIZE',
  'CHUNK',
  'FINALIZE',
];

export function nextStage(stage: IngestionStage): IngestionStage | null {
  const idx = M2_STAGE_ORDER.indexOf(stage);
  if (idx === -1) return null;
  if (idx === M2_STAGE_ORDER.length - 1) return null;
  return M2_STAGE_ORDER[idx + 1] ?? null;
}

export class StageError extends Error {
  constructor(
    public readonly stage: IngestionStage,
    message: string,
    public readonly code: string = 'STAGE_FAILED',
  ) {
    super(message);
    this.name = 'StageError';
  }
}

export interface RunStageResult {
  job: IngestionJob;
  /** The stage that just ran (== input stage), and the next one to run — or null when finished. */
  ranStage: IngestionStage;
  nextStage: IngestionStage | null;
  /** True when we short-circuited to FINALIZE on a duplicate upload. */
  duplicate?: boolean;
  /** Total chunk count after the run (only meaningful for the FINALIZE stage). */
  chunkCount?: number;
  documentId?: string;
  supersededDocumentId?: string;
  knowledgeRevision?: number;
}

/**
 * Execute one ingestion stage against the job. The Lambda handler wraps
 * this call to translate thrown errors into DynamoDB failure records. The
 * unit tests call this directly for a step-by-step trace.
 */
export async function runStage(
  jobIdInput: string,
  stage: IngestionStage,
  ctx: StageContext,
): Promise<RunStageResult> {
  const jobId = asIngestionJobId(jobIdInput);
  const job = await ctx.jobs.getJob(jobId);
  if (!job) throw new StageError(stage, `job not found: ${jobId}`, 'JOB_NOT_FOUND');

  ctx.logger?.info('stage begin', { jobId, stage });

  // Force a synthetic failure at the requested stage — used to exercise the
  // Step Functions failure path in tests and the dev deploy.
  if (job.forceFailureStage === stage) {
    await failJob(ctx, job, stage, `forced failure at stage ${stage}`, 'FORCED_FAILURE');
    throw new StageError(stage, `forced failure at stage ${stage}`, 'FORCED_FAILURE');
  }

  let mutated: IngestionJob = job;
  try {
    switch (stage) {
      case 'VALIDATE':
        mutated = await stageValidate(ctx, job);
        break;
      case 'FETCH':
        mutated = await stageFetch(ctx, job);
        break;
      case 'PARSE':
        mutated = await stageParse(ctx, job);
        break;
      case 'CLASSIFY':
        mutated = await stageClassify(ctx, job);
        break;
      case 'DISCOVER_ERRATA':
        mutated = await stageDiscoverErrata(ctx, job);
        break;
      case 'NORMALIZE':
        mutated = await stageNormalize(ctx, job);
        break;
      case 'CHUNK':
        mutated = await stageChunk(ctx, job);
        break;
      case 'FINALIZE':
        mutated = await stageFinalize(ctx, job);
        break;
      default:
        // EMBED / INDEX are stubbed in the state machine but not exercised
        // in M2; they light up in M3.
        mutated = await advanceStage(ctx, job, stage, {
          status: 'RUNNING',
        });
    }
  } catch (err) {
    if (err instanceof StageError) {
      await failJob(ctx, job, stage, err.message, err.code);
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    await failJob(ctx, job, stage, message, 'UNCAUGHT_ERROR');
    throw new StageError(stage, message);
  }

  const isDuplicate = mutated.duplicateOf !== undefined && stage === 'FETCH';
  const isFinished = mutated.status === 'SUCCEEDED';
  const next = isFinished ? null : nextStage(stage);
  ctx.logger?.info('stage end', { jobId, stage, next, status: mutated.status });
  const result: RunStageResult = {
    job: mutated,
    ranStage: stage,
    nextStage: next,
  };
  if (isDuplicate) result.duplicate = true;
  if (mutated.chunkCount !== undefined) result.chunkCount = mutated.chunkCount;
  if (mutated.documentId !== undefined) result.documentId = mutated.documentId;
  if (mutated.supersededDocumentId !== undefined) {
    result.supersededDocumentId = mutated.supersededDocumentId;
  }
  return result;
}

/** Run every remaining stage in order. Used for local tests + dev fixture. */
export async function runFullPipeline(
  jobId: string,
  ctx: StageContext,
  startingStage: IngestionStage = 'VALIDATE',
): Promise<RunStageResult> {
  let current: IngestionStage | null = startingStage;
  let lastResult: RunStageResult | null = null;
  while (current) {
    const res = await runStage(jobId, current, ctx);
    lastResult = res;
    current = res.nextStage;
  }
  if (!lastResult) throw new Error(`no stages ran for job ${jobId}`);
  return lastResult;
}

// ---------------------------------------------------------------------------
// Individual stages
// ---------------------------------------------------------------------------

async function stageValidate(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const game = await ctx.games.getGame(job.gameId);
  if (!game) throw new StageError('VALIDATE', `unknown gameId: ${job.gameId}`, 'UNKNOWN_GAME');
  const edition = game.editions.find((e) => e.editionId === job.editionId);
  if (!edition) {
    throw new StageError('VALIDATE', `unknown editionId: ${job.editionId}`, 'UNKNOWN_EDITION');
  }
  const content = await ctx.games.listContent(job.gameId);
  const pkg = content.find((c) => c.contentId === job.contentId);
  if (!pkg) {
    throw new StageError('VALIDATE', `unknown contentId: ${job.contentId}`, 'UNKNOWN_CONTENT');
  }
  if (pkg.editionId !== job.editionId) {
    throw new StageError(
      'VALIDATE',
      `contentId ${job.contentId} belongs to edition ${pkg.editionId}, not ${job.editionId}`,
      'CONTENT_EDITION_MISMATCH',
    );
  }
  return advanceStage(ctx, job, 'VALIDATE', { status: 'RUNNING' });
}

async function stageFetch(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const fetcher = job.source.kind === 'S3' ? ctx.s3Fetcher : ctx.urlFetcher;
  const fetched = await fetcher.fetch(job.source);
  const contentHash = sha256Hex(fetched.bytes);

  // Dedup — if we already have a document with the same bytes for this edition,
  // short-circuit. See MASTER_PLAN §18.
  const dup = await ctx.documents.findByContentHash(job.gameId, job.editionId, contentHash);
  if (dup) {
    ctx.logger?.info('duplicate upload — reusing existing document', {
      jobId: job.jobId,
      documentId: dup.documentId,
    });
    const finished = await ctx.jobs.updateJob(
      job.jobId,
      {
        status: 'SUCCEEDED',
        stage: 'FINALIZE',
        completedStages: appendStage(job.completedStages, ...M2_STAGE_ORDER),
        documentId: dup.documentId,
        duplicateOf: dup.documentId,
        chunkCount: dup.chunkCount,
      },
      ctx.now().toISOString(),
    );
    return finished;
  }

  // Persist raw bytes for URL sources — the S3 upload path already has them.
  let rawUri: string;
  if (job.source.kind === 'S3') {
    rawUri = ctx.rawStore.toUri(job.source.s3Key);
  } else {
    const key = `raw/url/${contentHash}.snapshot`;
    const put = await ctx.rawStore.putBytes(key, fetched.bytes, fetched.contentType);
    rawUri = put.uri;
  }

  const state: FetchState = {
    contentHash,
    rawUri,
    contentType: fetched.contentType,
    ...(fetched.canonicalUrl !== undefined ? { canonicalUrl: fetched.canonicalUrl } : {}),
    ...(fetched.filename !== undefined ? { filename: fetched.filename } : {}),
  };
  await writeState(ctx, job.jobId, 'fetch', state);
  return advanceStage(ctx, job, 'FETCH', { status: 'RUNNING' });
}

async function stageParse(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const fetchState = await readState<FetchState>(ctx, job.jobId, 'fetch');
  const bytes = await ctx.rawStore.getBytes(fetchState.rawUri);
  const parser = pickParser(ctx, fetchState.contentType);
  const parsed = await parser.parse(bytes, {
    contentType: fetchState.contentType,
    ...(fetchState.filename !== undefined ? { filename: fetchState.filename } : {}),
    ...(fetchState.canonicalUrl !== undefined ? { canonicalUrl: fetchState.canonicalUrl } : {}),
  });
  await writeState(ctx, job.jobId, 'parsed', parsed);
  return advanceStage(ctx, job, 'PARSE', { status: 'RUNNING' });
}

async function stageClassify(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const fetchState = await readState<FetchState>(ctx, job.jobId, 'fetch');
  const classification = classifySource({
    sourceType: job.sourceType,
    authority: job.authority,
    ...(fetchState.canonicalUrl !== undefined ? { canonicalUrl: fetchState.canonicalUrl } : {}),
    ...(fetchState.filename !== undefined ? { filename: fetchState.filename } : {}),
  });
  if (classification.warnings.length > 0) {
    ctx.logger?.warn('classification adjustments', {
      jobId: job.jobId,
      warnings: classification.warnings,
    });
  }
  return advanceStage(ctx, job, 'CLASSIFY', {
    status: 'RUNNING',
    authority: classification.authority,
    sourceType: classification.sourceType,
  });
}

async function stageDiscoverErrata(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  // M2 no-op — automatic errata/FAQ discovery is a M6 deliverable. We keep
  // the stage in the state machine so pipeline consumers can see it running.
  return advanceStage(ctx, job, 'DISCOVER_ERRATA', { status: 'RUNNING' });
}

async function stageNormalize(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const parsed = await readState<ParsedDocument>(ctx, job.jobId, 'parsed');
  const normalized: ParsedDocument = {
    ...parsed,
    blocks: parsed.blocks.map((b) => ({
      ...b,
      text: b.text.replace(/\s+/g, ' ').trim(),
    })),
  };
  await writeState(ctx, job.jobId, 'normalized', normalized);
  return advanceStage(ctx, job, 'NORMALIZE', { status: 'RUNNING' });
}

async function stageChunk(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const normalized = await readState<ParsedDocument>(ctx, job.jobId, 'normalized');
  const chunks = chunkDocument(normalized, ctx.chunkerOptions ?? {});
  await writeState(ctx, job.jobId, 'chunks', chunks);
  return advanceStage(ctx, job, 'CHUNK', {
    status: 'RUNNING',
    chunkCount: chunks.length,
  });
}

async function stageFinalize(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const parsed = await readState<ParsedDocument>(ctx, job.jobId, 'parsed');
  const fetchState = await readState<FetchState>(ctx, job.jobId, 'fetch');
  const chunkOutputs = await readState<
    Array<{
      ordinal: number;
      headingPath: string[];
      pageStart: number;
      pageEnd: number;
      text: string;
      charCount: number;
      tokenCount: number;
    }>
  >(ctx, job.jobId, 'chunks');

  // Idempotency — one more check by content hash. If we've been retried
  // after a partial finalize, prefer the existing document.
  const dup = await ctx.documents.findByContentHash(
    job.gameId,
    job.editionId,
    fetchState.contentHash,
  );

  const superseded = await ctx.documents.findCurrentByKey(
    job.gameId,
    job.editionId,
    job.contentId,
    job.sourceType,
  );

  const nowIso = ctx.now().toISOString();

  let documentId: string;
  let supersededId: string | undefined;
  let knowledgeRevision: number;
  const supersedesList: string[] = [];

  if (dup) {
    documentId = dup.documentId;
    knowledgeRevision = dup.knowledgeRevision;
  } else {
    documentId = ctx.ids.sourceDocumentId();
    if (superseded && superseded.documentId !== documentId) {
      supersedesList.push(superseded.documentId);
      supersededId = superseded.documentId;
      await ctx.documents.markSuperseded(superseded.documentId, nowIso);
    }
    knowledgeRevision = await ctx.games.bumpKnowledgeRevision(job.gameId, job.editionId, nowIso);
    const doc: SourceDocument = SourceDocumentSchema.parse({
      documentId: asSourceDocumentId(documentId),
      gameId: job.gameId,
      editionId: job.editionId,
      contentId: job.contentId,
      title: job.title,
      sourceType: job.sourceType,
      authority: job.authority,
      origin: job.source.kind === 'S3' ? 'UPLOAD' : 'URL',
      contentHash: fetchState.contentHash,
      rawObjectUri: fetchState.rawUri,
      pageCount: parsed.pageCount,
      chunkCount: chunkOutputs.length,
      status: 'CURRENT',
      supersedes: supersedesList,
      knowledgeRevision,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(job.version !== undefined ? { version: job.version } : {}),
      ...(fetchState.canonicalUrl !== undefined ? { canonicalUrl: fetchState.canonicalUrl } : {}),
      ...(fetchState.canonicalUrl
        ? { publisherDomain: safeHostname(fetchState.canonicalUrl) }
        : {}),
    });
    await ctx.documents.createDocument(doc);

    // Persist each chunk body to S3 + its metadata row to DynamoDB.
    const chunkRecords: Chunk[] = [];
    for (const c of chunkOutputs) {
      const chunkId = ctx.ids.chunkId();
      const textKey = `normalized/${documentId}/${chunkId}.txt`;
      const put = await ctx.normalizedStore.putBytes(textKey, c.text, 'text/plain; charset=utf-8');
      chunkRecords.push(
        ChunkSchema.parse({
          chunkId: asChunkId(chunkId),
          documentId: asSourceDocumentId(documentId),
          gameId: job.gameId,
          editionId: job.editionId,
          contentId: job.contentId,
          ordinal: c.ordinal,
          headingPath: c.headingPath,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          textUri: put.uri,
          textPreview: c.text.slice(0, 400),
          charCount: c.charCount,
          tokenCount: c.tokenCount,
          authority: job.authority,
          sourceType: job.sourceType,
          isCurrent: true,
          createdAt: nowIso,
          ...(job.version !== undefined ? { documentVersion: job.version } : {}),
        }),
      );
    }
    if (chunkRecords.length > 0) {
      await ctx.chunks.putChunks(chunkRecords);
    }
    await ctx.documents.updateChunkCount(
      asSourceDocumentId(documentId),
      chunkRecords.length,
      nowIso,
    );
  }

  const patch: Partial<Omit<IngestionJob, 'jobId' | 'createdAt'>> = {
    status: 'SUCCEEDED',
    stage: 'FINALIZE',
    completedStages: appendStage(job.completedStages, ...M2_STAGE_ORDER),
    documentId: asSourceDocumentId(documentId),
    chunkCount: chunkOutputs.length,
  };
  if (supersededId !== undefined) patch.supersededDocumentId = asSourceDocumentId(supersededId);
  const updated = await ctx.jobs.updateJob(job.jobId, patch, nowIso);
  return IngestionJobSchema.parse(updated);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchState {
  contentHash: string;
  rawUri: string;
  contentType: string;
  canonicalUrl?: string;
  filename?: string;
}

function appendStage(existing: IngestionStage[], ...stages: IngestionStage[]): IngestionStage[] {
  const set = new Set(existing);
  for (const s of stages) set.add(s);
  return M2_STAGE_ORDER.filter((s) => set.has(s));
}

async function advanceStage(
  ctx: StageContext,
  job: IngestionJob,
  finishedStage: IngestionStage,
  patch: Partial<Omit<IngestionJob, 'jobId' | 'createdAt'>>,
): Promise<IngestionJob> {
  const next = nextStage(finishedStage);
  const combined: Partial<Omit<IngestionJob, 'jobId' | 'createdAt'>> = {
    ...patch,
    completedStages: appendStage(job.completedStages, finishedStage),
    stage: next ?? finishedStage,
    status: next === null ? (patch.status ?? 'SUCCEEDED') : (patch.status ?? 'RUNNING'),
  };
  return ctx.jobs.updateJob(job.jobId, combined, ctx.now().toISOString());
}

async function failJob(
  ctx: StageContext,
  job: IngestionJob,
  stage: IngestionStage,
  message: string,
  code: string,
): Promise<void> {
  try {
    await ctx.jobs.updateJob(
      job.jobId,
      {
        status: 'FAILED',
        stage,
        error: { stage, message, code },
      },
      ctx.now().toISOString(),
    );
  } catch (err) {
    ctx.logger?.error('failed to persist failure', {
      jobId: job.jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function pickParser(ctx: StageContext, contentType: string): DocumentParser {
  const lc = contentType.toLowerCase();
  if (lc.includes('pdf')) return ctx.pdfParser;
  if (lc.includes('html') || lc.includes('xhtml') || lc.startsWith('text/')) {
    return ctx.htmlParser;
  }
  return createHtmlParser();
}

async function writeState<T>(
  ctx: StageContext,
  jobId: IngestionJobId,
  key: string,
  data: T,
): Promise<void> {
  const path = `normalized/${jobId}/state/${key}.json`;
  await ctx.normalizedStore.putBytes(path, JSON.stringify(data), 'application/json');
}

async function readState<T>(ctx: StageContext, jobId: IngestionJobId, key: string): Promise<T> {
  const uri = ctx.normalizedStore.toUri(`normalized/${jobId}/state/${key}.json`);
  const text = await ctx.normalizedStore.getText(uri);
  return JSON.parse(text) as T;
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Convenience typed helper for constructing a job before insertion. */
export function seedJob(overrides: Partial<IngestionJob> = {}): IngestionJob {
  return IngestionJobSchema.parse({
    jobId: 'job_seed',
    gameId: 'g_seed' as GameId,
    editionId: 'e_seed' as EditionId,
    contentId: 'c_seed' as ContentId,
    title: 'Seed',
    sourceType: 'RULEBOOK' as SourceType,
    authority: 'OFFICIAL_RULES',
    source: { kind: 'S3', s3Key: 'raw/seed.pdf', contentType: 'application/pdf' },
    status: 'PENDING',
    stage: 'VALIDATE',
    completedStages: [],
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  });
}
