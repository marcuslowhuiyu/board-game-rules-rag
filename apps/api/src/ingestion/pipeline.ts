import {
  ChunkSchema,
  IngestionJobSchema,
  IngestionQualityReportSchema,
  SourceDocumentSchema,
  asChunkId,
  asIngestionJobId,
  asSourceDocumentId,
  type Chunk,
  type Edition,
  type Game,
  type IngestionJob,
  type IngestionJobId,
  type IngestionStage,
  type SourceDocument,
  type SourceDocumentId,
} from '@bgr/domain';
import type { EmbeddingsProvider } from '@bgr/ai';
import { chunkVectorMetadata, embeddingText } from '@bgr/retrieval';
import type { VectorIndex, VectorItem } from '@bgr/retrieval';
import type { Logger } from '@bgr/shared';
import type {
  AtomicPublisher,
  ChunksRepository,
  DocumentsRepository,
  GamesRepository,
  IdGenerator,
  IngestionJobsRepository,
} from '@bgr/persistence';
import { PublishConflictError } from '@bgr/persistence';
import {
  classifySource,
  chunkDocument,
  createHtmlParser,
  sha256Hex,
  type ChunkerOptions,
  type DocumentFetcher,
  type DocumentParser,
  type DocumentQualityReport,
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
  publisher: AtomicPublisher;
  /** Raw source bytes bucket (`raw/…`). */
  rawStore: ObjectStore;
  /**
   * Bucket for chunk bodies and transient per-stage state.
   * Chunk bodies live at `normalized/{documentId}/{chunkId}.txt` (persistent).
   * Transient stage state lives at `stage-state/ingestion/{jobId}/*.json`.
   */
  normalizedStore: ObjectStore;
  urlFetcher: DocumentFetcher;
  s3Fetcher: DocumentFetcher;
  pdfParser: DocumentParser;
  htmlParser: DocumentParser;
  chunkerOptions?: ChunkerOptions;
  /** Embeds chunk text at EMBED (ADR-0002: Titan V2). */
  embeddings: EmbeddingsProvider;
  /** Where INDEX writes chunk vectors (S3 Vectors in AWS). */
  vectorIndex: VectorIndex;
  logger?: Logger;
}

/**
 * PARSE fails when more than this share of extracted characters are
 * replacement/control glyphs (broken text layer). Initial value from the
 * M2-R3 spec; tune after real-rulebook acceptance.
 */
const GARBLED_CHAR_RATIO_LIMIT = 0.05;

/** Ordered list of the stages the state machine runs. */
export const INGESTION_STAGE_ORDER: IngestionStage[] = [
  'VALIDATE',
  'FETCH',
  'PARSE',
  'CLASSIFY',
  'DISCOVER_ERRATA',
  'NORMALIZE',
  'CHUNK',
  'EMBED',
  'INDEX',
  'FINALIZE',
];

/** Stages that turn fetched bytes into chunks; skipped when the bytes are already a document. */
const CHUNKING_STAGES: IngestionStage[] = [
  'PARSE',
  'CLASSIFY',
  'DISCOVER_ERRATA',
  'NORMALIZE',
  'CHUNK',
];

export function nextStage(stage: IngestionStage): IngestionStage | null {
  const idx = INGESTION_STAGE_ORDER.indexOf(stage);
  if (idx === -1) return null;
  if (idx === INGESTION_STAGE_ORDER.length - 1) return null;
  return INGESTION_STAGE_ORDER[idx + 1] ?? null;
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

/**
 * A stage failure that re-reading state and running the stage again may
 * resolve (e.g. FINALIZE lost an optimistic-concurrency race). The runner
 * does NOT persist FAILED for these; the error propagates to Step Functions,
 * whose Retry policy matches on `name` (the Lambda `errorType`). Only once
 * retries are exhausted does the Catch → MarkJobFailed path record FAILED.
 */
export class RetryableStageError extends StageError {
  constructor(stage: IngestionStage, message: string, code: string) {
    super(stage, message, code);
    this.name = 'RetryableStageError';
  }
}

export interface RunStageResult {
  job: IngestionJob;
  ranStage: IngestionStage;
  /** Next stage the state machine should invoke, or null when finished. */
  nextStage: IngestionStage | null;
  /** True when the pipeline is done (success or duplicate). */
  terminal: boolean;
  status: IngestionJob['status'];
  duplicate?: boolean;
  chunkCount?: number;
  documentId?: string;
  supersededDocumentId?: string;
  /** True when the stage did nothing because the job is already terminal. */
  alreadyTerminal?: boolean;
}

/**
 * Execute one ingestion stage against the job. Idempotent: if the job is
 * already terminal (SUCCEEDED or FAILED), this is a no-op and returns
 * `terminal: true` so the state machine can exit cleanly on a retry.
 */
export async function runStage(
  jobIdInput: string,
  stage: IngestionStage,
  ctx: StageContext,
): Promise<RunStageResult> {
  const jobId = asIngestionJobId(jobIdInput);
  const job = await ctx.jobs.getJob(jobId);
  if (!job) throw new StageError(stage, `job not found: ${jobId}`, 'JOB_NOT_FOUND');

  ctx.logger?.info('stage begin', { jobId, stage, status: job.status });

  // Already terminal — safe no-op for retries (an at-least-once state
  // machine invocation must not re-run a stage on a completed/failed job).
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
    return {
      job,
      ranStage: stage,
      nextStage: null,
      terminal: true,
      status: job.status,
      alreadyTerminal: true,
      ...(job.documentId ? { documentId: job.documentId } : {}),
      ...(job.chunkCount !== undefined ? { chunkCount: job.chunkCount } : {}),
      ...(job.duplicateOf ? { duplicate: true } : {}),
      ...(job.supersededDocumentId ? { supersededDocumentId: job.supersededDocumentId } : {}),
    };
  }

  // A stage already recorded as done is a no-op: a redelivered invocation,
  // or a chunking stage FETCH skipped because the bytes are already a
  // document. FINALIZE always runs — it decides the terminal outcome.
  if (stage !== 'FINALIZE' && job.completedStages.includes(stage)) {
    return {
      job,
      ranStage: stage,
      nextStage: nextStage(stage),
      terminal: false,
      status: job.status,
    };
  }

  // Synthetic failure — internal test-only affordance. `forceFailureStage`
  // is not accepted from the public `POST /ingestion` schema; tests set it
  // via the InternalCreateIngestionJobInputSchema.
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
      case 'EMBED':
        mutated = await stageEmbed(ctx, job);
        break;
      case 'INDEX':
        mutated = await stageIndex(ctx, job);
        break;
      case 'FINALIZE':
        mutated = await stageFinalize(ctx, job);
        break;
    }
  } catch (err) {
    if (err instanceof RetryableStageError) {
      ctx.logger?.warn('stage hit a retryable conflict', { jobId, stage, code: err.code });
      throw err;
    }
    if (err instanceof StageError) {
      await failJob(ctx, job, stage, err.message, err.code);
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    await failJob(ctx, job, stage, message, 'UNCAUGHT_ERROR');
    throw new StageError(stage, message);
  }

  const isDuplicate =
    mutated.duplicateOf !== undefined && mutated.duplicateOf !== mutated.plannedDocumentId;
  const isFinished = mutated.status === 'SUCCEEDED';
  const next = isFinished ? null : nextStage(stage);
  ctx.logger?.info('stage end', { jobId, stage, next, status: mutated.status });
  const result: RunStageResult = {
    job: mutated,
    ranStage: stage,
    nextStage: next,
    terminal: isFinished || mutated.status === 'FAILED' || next === null,
    status: mutated.status,
  };
  if (isDuplicate) result.duplicate = true;
  if (mutated.chunkCount !== undefined) result.chunkCount = mutated.chunkCount;
  if (mutated.documentId !== undefined) result.documentId = mutated.documentId;
  if (mutated.supersededDocumentId !== undefined) {
    result.supersededDocumentId = mutated.supersededDocumentId;
  }
  return result;
}

/** Run every remaining stage in order. Used for local tests + dev fixtures. */
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
    if (res.terminal) break;
    current = res.nextStage;
  }
  if (!lastResult) throw new Error(`no stages ran for job ${jobId}`);
  return lastResult;
}

// ---------------------------------------------------------------------------
// Stages
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

  // Dedup — see ADR-0008. Scope: (game, edition, contentId, contentHash).
  const dup = await ctx.documents.findByContentHash(
    job.gameId,
    job.editionId,
    job.contentId,
    contentHash,
  );
  // Snapshot the exact bytes we hashed under a content-addressed key, for
  // uploads too: a presigned PUT URL stays valid until expiry, so the upload
  // key may be overwritten before PARSE reads it.
  const snapshotKey =
    job.source.kind === 'S3'
      ? `raw/upload/${contentHash}${uploadExtension(job.source.s3Key)}`
      : `raw/url/${contentHash}.snapshot`;
  const put = await ctx.rawStore.putBytes(snapshotKey, fetched.bytes, fetched.contentType);
  const rawUri = put.uri;

  const state: FetchState = {
    contentHash,
    rawUri,
    contentType: fetched.contentType,
    ...(fetched.canonicalUrl !== undefined ? { canonicalUrl: fetched.canonicalUrl } : {}),
    ...(fetched.filename !== undefined ? { filename: fetched.filename } : {}),
  };
  await writeState(ctx, job.jobId, 'fetch', state);
  if (dup) {
    // The bytes are already a document, so its chunks exist: skip parsing and
    // chunking. EMBED and INDEX still run for that document, so a re-upload
    // repairs missing vectors (and backfills documents ingested before M3).
    // FINALIZE then reports the duplicate (CURRENT) or reinstates the
    // document (SUPERSEDED), retrying on a conflicting concurrent publish.
    ctx.logger?.info('re-upload of an existing document — re-indexing it', {
      jobId: job.jobId,
      documentId: dup.documentId,
      status: dup.status,
    });
    return ctx.jobs.updateJob(
      job.jobId,
      {
        status: 'RUNNING',
        stage: 'EMBED',
        completedStages: appendStage(job.completedStages, 'FETCH', ...CHUNKING_STAGES),
      },
      ctx.now().toISOString(),
    );
  }
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

  // Quality gate (ADR-0008 §5): OCR/AI fallback is not implemented in M2,
  // so an inadequate deterministic extraction must not become authoritative
  // knowledge. Fail here (never inside FINALIZE) so `knowledgeRevision`
  // remains untouched.
  const qualityReport = normalizeQualityReport(parsed.quality);
  await ctx.jobs.updateJob(job.jobId, { qualityReport }, ctx.now().toISOString());
  if (parsed.blocks.length === 0) {
    throw new StageError(
      'PARSE',
      `parser emitted zero blocks (${qualityReport.warnings.join('; ') || 'no warnings'})`,
      'EMPTY_PARSE',
    );
  }
  if (parsed.quality.garbledCharRatio > GARBLED_CHAR_RATIO_LIMIT) {
    throw new StageError(
      'PARSE',
      `${(parsed.quality.garbledCharRatio * 100).toFixed(1)}% of extracted characters are garbled/replacement`,
      'GARBLED_EXTRACTION',
    );
  }
  // Scan and empty-page heuristics only mean something for paged PDF text
  // layers; a short HTML page is legitimately low-density (ADR-0008 §Quality gate).
  if (parser === ctx.pdfParser) {
    if (parsed.quality.isLikelyScan) {
      throw new StageError(
        'PARSE',
        `deterministic PDF extraction inadequate: ${qualityReport.warnings.join('; ') || 'likely scan'}`,
        'LIKELY_SCAN',
      );
    }
    if (parsed.quality.emptyPageRatio > 0.7) {
      throw new StageError(
        'PARSE',
        `${(parsed.quality.emptyPageRatio * 100).toFixed(0)}% of pages produced no text`,
        'HIGH_EMPTY_PAGE_RATIO',
      );
    }
  }

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

async function stageChunk(ctx: StageContext, jobIn: IngestionJob): Promise<IngestionJob> {
  let job = jobIn;
  const normalized = await readState<ParsedDocument>(ctx, job.jobId, 'normalized');
  const chunkOutputs = chunkDocument(normalized, ctx.chunkerOptions ?? {});
  if (chunkOutputs.length === 0) {
    throw new StageError('CHUNK', 'chunker produced zero chunks', 'ZERO_CHUNKS');
  }

  // Reserve the destination document id once, and persist it on the job
  // BEFORE any chunk artifact is written. A retry after a crash anywhere
  // below then reuses the same id, so S3 bodies and DDB rows (keyed
  // deterministically by (plannedDocumentId, ordinal)) are overwritten rather
  // than orphaned under a fresh id.
  let plannedDocumentId = job.plannedDocumentId;
  if (plannedDocumentId === undefined) {
    plannedDocumentId = asSourceDocumentId(ctx.ids.sourceDocumentId());
    job = await ctx.jobs.updateJob(job.jobId, { plannedDocumentId }, ctx.now().toISOString());
  }

  const nowIso = ctx.now().toISOString();
  const chunkRecords: Chunk[] = [];
  for (const c of chunkOutputs) {
    const chunkId = deriveChunkId(plannedDocumentId, c.ordinal);
    const textKey = `normalized/${plannedDocumentId}/${chunkId}.txt`;
    const put = await ctx.normalizedStore.putBytes(textKey, c.text, 'text/plain; charset=utf-8');
    chunkRecords.push(
      ChunkSchema.parse({
        chunkId: asChunkId(chunkId),
        documentId: asSourceDocumentId(plannedDocumentId),
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
        createdAt: nowIso,
        ...(job.version !== undefined ? { documentVersion: job.version } : {}),
      }),
    );
  }
  await ctx.chunks.putChunks(chunkRecords);

  return advanceStage(ctx, job, 'CHUNK', {
    status: 'RUNNING',
    chunkCount: chunkRecords.length,
    pageCount: normalized.pageCount,
  });
}

async function stageEmbed(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const documentId = await indexedDocumentId(ctx, job);
  const chunks = await ctx.chunks.listChunksForDocument(documentId);
  if (chunks.length === 0) {
    throw new StageError('EMBED', `no chunks to embed for ${documentId}`, 'NO_CHUNKS');
  }
  const game = await ctx.games.getGame(job.gameId);
  const content = (await ctx.games.listContent(job.gameId)).find(
    (c) => c.contentId === job.contentId,
  );
  if (!game || !content) {
    throw new StageError('EMBED', `game or content vanished for job ${job.jobId}`, 'GAME_MISSING');
  }

  const bodies = await Promise.all(chunks.map((c) => ctx.normalizedStore.getText(c.textUri)));
  const { vectors, inputTokens } = await ctx.embeddings.embed(
    chunks.map((c, i) =>
      embeddingText({
        gameName: game.name,
        contentName: content.name,
        headingPath: c.headingPath,
        text: bodies[i]!,
      }),
    ),
  );
  const items: VectorItem[] = chunks.map((c, i) => ({
    key: c.chunkId,
    vector: vectors[i]!,
    metadata: chunkVectorMetadata(c, bodies[i]!),
  }));
  await writeState(ctx, job.jobId, 'vectors', items);
  ctx.logger?.info('embedded chunks', {
    jobId: job.jobId,
    documentId,
    chunks: items.length,
    inputTokens,
    modelId: ctx.embeddings.modelId,
  });
  return advanceStage(ctx, job, 'EMBED', { status: 'RUNNING' });
}

async function stageIndex(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const items = await readState<VectorItem[]>(ctx, job.jobId, 'vectors');
  await ctx.vectorIndex.putVectors(items);
  return advanceStage(ctx, job, 'INDEX', { status: 'RUNNING' });
}

/**
 * The document whose chunks this job indexes: the one CHUNK planned, or —
 * when FETCH found the bytes already published — that existing document.
 */
async function indexedDocumentId(ctx: StageContext, job: IngestionJob): Promise<SourceDocumentId> {
  if (job.plannedDocumentId) return job.plannedDocumentId;
  const fetchState = await readState<FetchState>(ctx, job.jobId, 'fetch');
  const existing = await ctx.documents.findByContentHash(
    job.gameId,
    job.editionId,
    job.contentId,
    fetchState.contentHash,
  );
  if (!existing) {
    throw new StageError('EMBED', 'no planned or existing document to index', 'NO_DOCUMENT');
  }
  return existing.documentId;
}

async function stageFinalize(ctx: StageContext, job: IngestionJob): Promise<IngestionJob> {
  const fetchState = await readState<FetchState>(ctx, job.jobId, 'fetch');

  // Read the game BEFORE the dedup lookup. Its `updatedAt` guards the publish
  // transaction, so if a concurrent job publishes the same bytes after our
  // lookup missed, our publish fails as GAME_STALE and the retry finds the
  // duplicate — instead of publishing the same hash twice.
  const game = await ctx.games.getGame(job.gameId);
  if (!game) throw new StageError('FINALIZE', `game vanished: ${job.gameId}`, 'GAME_MISSING');
  const editionIdx = game.editions.findIndex((e) => e.editionId === job.editionId);
  if (editionIdx === -1) {
    throw new StageError('FINALIZE', `edition vanished: ${job.editionId}`, 'EDITION_MISSING');
  }
  const currentEdition = game.editions[editionIdx]!;
  const newRev = currentEdition.knowledgeRevision + 1;

  // Duplicate short-circuit (also serves as retry-recovery — see below).
  const dup = await ctx.documents.findByContentHash(
    job.gameId,
    job.editionId,
    job.contentId,
    fetchState.contentHash,
  );
  if (dup) {
    if (dup.documentId === job.plannedDocumentId) {
      // This job already published successfully; a subsequent retry landed
      // here after `updateJob` crashed. Treat as success, not duplicate.
      return ctx.jobs.updateJob(
        job.jobId,
        {
          status: 'SUCCEEDED',
          stage: 'FINALIZE',
          completedStages: appendStage(job.completedStages, ...INGESTION_STAGE_ORDER),
          documentId: dup.documentId,
          chunkCount: dup.chunkCount,
        },
        ctx.now().toISOString(),
      );
    }
    if (dup.status === 'SUPERSEDED') {
      return reinstateDocument(ctx, job, dup, game, editionIdx);
    }
    // Real duplicate — some other document already carries these bytes.
    return markDuplicate(ctx, job, dup);
  }

  if (!job.plannedDocumentId) {
    throw new StageError(
      'FINALIZE',
      'plannedDocumentId is missing — CHUNK did not run',
      'NO_PLANNED_DOC',
    );
  }

  // Verify chunks were persisted before we touch authoritative state.
  const persistedChunks = await ctx.chunks.listChunksForDocument(job.plannedDocumentId);
  if (job.chunkCount === undefined || persistedChunks.length !== job.chunkCount) {
    throw new StageError(
      'FINALIZE',
      `chunk count mismatch: expected ${job.chunkCount}, found ${persistedChunks.length}`,
      'CHUNK_COUNT_MISMATCH',
    );
  }

  const superseded = await ctx.documents.findCurrentByKey(
    job.gameId,
    job.editionId,
    job.contentId,
    job.sourceType,
  );

  const nowIso = ctx.now().toISOString();
  // Fall back to the chunk-derived page count only for jobs that reached
  // CHUNK before `pageCount` was recorded on the job.
  const pageCount =
    job.pageCount ?? persistedChunks.reduce((max, c) => Math.max(max, c.pageEnd), 0);

  const newDoc: SourceDocument = SourceDocumentSchema.parse({
    documentId: job.plannedDocumentId,
    gameId: job.gameId,
    editionId: job.editionId,
    contentId: job.contentId,
    title: job.title,
    sourceType: job.sourceType,
    authority: job.authority,
    origin: job.source.kind === 'S3' ? 'UPLOAD' : 'URL',
    contentHash: fetchState.contentHash,
    rawObjectUri: fetchState.rawUri,
    pageCount,
    chunkCount: persistedChunks.length,
    status: 'CURRENT',
    supersedes: superseded ? [superseded.documentId] : [],
    knowledgeRevision: newRev,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(job.version !== undefined ? { version: job.version } : {}),
    ...(fetchState.canonicalUrl !== undefined ? { canonicalUrl: fetchState.canonicalUrl } : {}),
    ...(fetchState.canonicalUrl ? { publisherDomain: safeHostname(fetchState.canonicalUrl) } : {}),
  });

  const nextEditions: Edition[] = game.editions.slice();
  nextEditions[editionIdx] = {
    ...currentEdition,
    knowledgeRevision: newRev,
    updatedAt: nowIso,
  };

  // The job's SUCCEEDED write rides in the same transaction as the publish
  // (ADR-0008 §FINALIZE), so there is no window in which the document is
  // CURRENT but the job still reads RUNNING.
  const completedJob: IngestionJob = IngestionJobSchema.parse({
    ...job,
    status: 'SUCCEEDED',
    stage: 'FINALIZE',
    completedStages: appendStage(job.completedStages, ...INGESTION_STAGE_ORDER),
    documentId: newDoc.documentId,
    chunkCount: persistedChunks.length,
    ...(superseded ? { supersededDocumentId: superseded.documentId } : {}),
    updatedAt: nowIso,
  });

  try {
    await ctx.publisher.publishDocument({
      newDocument: newDoc,
      ...(superseded ? { supersedeDocumentId: superseded.documentId } : {}),
      gameId: job.gameId,
      nextEditions,
      expectedGameUpdatedAt: game.updatedAt,
      completedJob,
      expectedJobUpdatedAt: job.updatedAt,
      now: nowIso,
    });
  } catch (err) {
    if (err instanceof PublishConflictError) {
      if (err.reason === 'DOC_EXISTS') {
        // Defensive: with the job write inside the transaction, a published
        // document implies a SUCCEEDED job, so a retry normally exits at the
        // already-terminal check in `runStage`. If the job row was nonetheless
        // left non-terminal (manual repair, legacy data), recover as success
        // — not "duplicate", because it's the same doc we planned.
        const existing = await ctx.documents.getDocument(job.plannedDocumentId as SourceDocumentId);
        if (!existing) {
          throw new StageError(
            'FINALIZE',
            'DOC_EXISTS reported but document could not be read on retry',
            'PUBLISH_RECOVERY_FAILED',
          );
        }
        return ctx.jobs.updateJob(
          job.jobId,
          {
            status: 'SUCCEEDED',
            stage: 'FINALIZE',
            completedStages: appendStage(job.completedStages, ...INGESTION_STAGE_ORDER),
            documentId: existing.documentId,
            chunkCount: existing.chunkCount,
            ...(existing.supersedes.length > 0
              ? { supersededDocumentId: existing.supersedes[0]! }
              : {}),
          },
          ctx.now().toISOString(),
        );
      }
      // GAME_STALE / PREV_NOT_CURRENT / JOB_STALE — not terminal. Leave the
      // job RUNNING and let the state machine retry FINALIZE, which re-reads
      // the game row, the previous CURRENT doc and the job.
      throw new RetryableStageError('FINALIZE', err.message, err.reason);
    }
    throw err;
  }

  return completedJob;
}

/** Bytes already published as the CURRENT document: report it, change nothing. */
function markDuplicate(
  ctx: StageContext,
  job: IngestionJob,
  dup: SourceDocument,
): Promise<IngestionJob> {
  return ctx.jobs.updateJob(
    job.jobId,
    {
      status: 'SUCCEEDED',
      stage: 'FINALIZE',
      completedStages: appendStage(job.completedStages, ...INGESTION_STAGE_ORDER),
      documentId: dup.documentId,
      duplicateOf: dup.documentId,
      chunkCount: dup.chunkCount,
    },
    ctx.now().toISOString(),
  );
}

/**
 * Re-uploaded bytes match a SUPERSEDED document: uploading means "make this
 * the live version" (ADR-0008 §Reinstating a superseded version). The old
 * document returns to CURRENT with its existing chunks, the present CURRENT
 * one is superseded and the revision bumps — the same atomic publish as a
 * new version, conditional on the document still being SUPERSEDED.
 */
async function reinstateDocument(
  ctx: StageContext,
  job: IngestionJob,
  doc: SourceDocument,
  game: Game,
  editionIdx: number,
): Promise<IngestionJob> {
  const current = await ctx.documents.findCurrentByKey(
    doc.gameId,
    doc.editionId,
    doc.contentId,
    doc.sourceType,
  );
  if (current?.documentId === doc.documentId) {
    // Another job reinstated it after our dedup lookup. Publishing now would
    // put and supersede the same item in one transaction, which DynamoDB
    // rejects as invalid (not as a retryable conflict). Retry instead: the
    // fresh lookup sees it CURRENT and reports a duplicate.
    throw new RetryableStageError(
      'FINALIZE',
      `document ${doc.documentId} was reinstated concurrently`,
      'DOC_NOT_SUPERSEDED',
    );
  }
  const nowIso = ctx.now().toISOString();
  const edition = game.editions[editionIdx]!;
  const newRev = edition.knowledgeRevision + 1;
  const nextEditions: Edition[] = game.editions.slice();
  nextEditions[editionIdx] = { ...edition, knowledgeRevision: newRev, updatedAt: nowIso };

  const reinstated: SourceDocument = SourceDocumentSchema.parse({
    ...doc,
    status: 'CURRENT',
    knowledgeRevision: newRev,
    supersedes:
      current && !doc.supersedes.includes(current.documentId)
        ? [...doc.supersedes, current.documentId]
        : doc.supersedes,
    updatedAt: nowIso,
  });
  const completedJob: IngestionJob = IngestionJobSchema.parse({
    ...job,
    status: 'SUCCEEDED',
    stage: 'FINALIZE',
    completedStages: appendStage(job.completedStages, ...INGESTION_STAGE_ORDER),
    documentId: doc.documentId,
    chunkCount: doc.chunkCount,
    ...(current ? { supersededDocumentId: current.documentId } : {}),
    updatedAt: nowIso,
  });

  try {
    await ctx.publisher.publishDocument({
      newDocument: reinstated,
      reinstate: true,
      ...(current ? { supersedeDocumentId: current.documentId } : {}),
      gameId: job.gameId,
      nextEditions,
      expectedGameUpdatedAt: game.updatedAt,
      completedJob,
      expectedJobUpdatedAt: job.updatedAt,
      now: nowIso,
    });
  } catch (err) {
    if (err instanceof PublishConflictError) {
      // Something moved (another publish, or the document was reinstated
      // already) — the retry re-reads and may land on the duplicate path.
      throw new RetryableStageError('FINALIZE', err.message, err.reason);
    }
    throw err;
  }
  return completedJob;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extension of an upload key (`.pdf`, `.html`), kept on its snapshot. */
function uploadExtension(s3Key: string): string {
  return /\.[A-Za-z0-9]{1,8}$/.exec(s3Key)?.[0]?.toLowerCase() ?? '';
}

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
  return INGESTION_STAGE_ORDER.filter((s) => set.has(s));
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
    // Conditional write: never downgrade a finished job. FINALIZE's
    // transaction may have committed SUCCEEDED before a later error (e.g. a
    // lost response) reached this handler.
    const outcome = await ctx.jobs.markFailedIfActive(
      job.jobId,
      { stage, message, code },
      ctx.now().toISOString(),
    );
    if (outcome === 'NOT_APPLIED') {
      ctx.logger?.warn('job already terminal; failure not recorded', {
        jobId: job.jobId,
        stage,
        code,
      });
    }
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

/**
 * Per-job transient state. Its own top-level prefix so exactly one S3
 * lifecycle rule (7-day expiry) applies — see ADR-0008 §Storage lifecycle.
 */
export function stageStateKey(jobId: IngestionJobId, key: string): string {
  return `stage-state/ingestion/${jobId}/${key}.json`;
}

async function writeState<T>(
  ctx: StageContext,
  jobId: IngestionJobId,
  key: string,
  data: T,
): Promise<void> {
  const path = stageStateKey(jobId, key);
  await ctx.normalizedStore.putBytes(path, JSON.stringify(data), 'application/json');
}

async function readState<T>(ctx: StageContext, jobId: IngestionJobId, key: string): Promise<T> {
  const uri = ctx.normalizedStore.toUri(stageStateKey(jobId, key));
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

function normalizeQualityReport(input: DocumentQualityReport) {
  return IngestionQualityReportSchema.parse({
    emptyPageRatio: input.emptyPageRatio,
    averageCharsPerPage: input.averageCharsPerPage,
    garbledCharRatio: input.garbledCharRatio,
    isLikelyScan: input.isLikelyScan,
    warnings: input.warnings.slice(0, 32),
  });
}

/**
 * Deterministic per-document chunk id. Encoding: `ch_<docSuffix>_<ordinal>`
 * where `docSuffix` is the plannedDocumentId with any `doc_` prefix
 * stripped. Keeps chunk writes idempotent across CHUNK-stage retries.
 */
export function deriveChunkId(documentId: string, ordinal: number): string {
  const suffix = documentId.startsWith('doc_') ? documentId.slice(4) : documentId;
  const trimmed = suffix.slice(0, 40);
  return `ch_${trimmed}_${ordinal.toString().padStart(4, '0')}`;
}

/** Test helper — a validated job with sensible defaults. */
export function seedJob(overrides: Partial<IngestionJob> = {}): IngestionJob {
  return IngestionJobSchema.parse({
    jobId: 'job_seed',
    gameId: 'g_seed',
    editionId: 'e_seed',
    contentId: 'c_seed',
    title: 'Seed',
    sourceType: 'RULEBOOK',
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
