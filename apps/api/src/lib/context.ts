import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  ANSWERER_PROMPT_VERSION,
  ConverseStructuredModel,
  RERANKER_PROMPT_VERSION,
  ROUTER_PROMPT_VERSION,
  TitanEmbeddingsProvider,
  createPassageRanker,
  createQuestionClassifier,
  createRulesAnswerer,
  loadModelCatalog,
  modelFor,
} from '@bgr/ai';
import {
  createAnswerPipeline,
  recordModelCall,
  setUnroutedCallListener,
  type SourceRecord,
} from '@bgr/answering';
import { S3VectorIndex, VectorRulesRetriever, type EvidenceLimits } from '@bgr/retrieval';
import { createLogger } from '@bgr/shared';
import {
  DynamoChunksRepository,
  DynamoDocumentsRepository,
  DynamoGamesRepository,
  DynamoIngestionJobsRepository,
  DynamoMessagesRepository,
  DynamoSessionsRepository,
  DynamoSpendLedger,
  cryptoIdGenerator,
  systemClock,
  type ChunksRepository,
  type Clock,
  type DocumentsRepository,
  type GamesRepository,
  type IdGenerator,
  type IngestionJobsRepository,
  type MessagesRepository,
  type SessionsRepository,
} from '@bgr/persistence';
import { asSourceDocumentId, type IngestionJobId } from '@bgr/domain';
import { vectorSettingsFromEnv } from '../ingestion/stage-context.js';
import { createS3UploadPresigner } from './presigner.js';
import { S3ObjectStore } from './s3-object-store.js';

export interface AppConfig {
  gamesTable: string;
  contentTable: string;
  sessionsTable: string;
  messagesTable: string;
  documentsTable: string;
  chunksTable: string;
  ingestionJobsTable: string;
  sessionTtlSeconds: number;
  allowedOrigin: string;
  ingestionBucket: string;
  ingestionStateMachineArn?: string;
  uploadMaxBytes: number;
  presignExpirySeconds: number;
  region: string;
}

/** Settings of the answer pipeline; read lazily, on the first question (set by CDK). */
export interface AnsweringConfig {
  usageTable: string;
  dailyAiCapUsd: number;
  modelRequestTimeoutMs: number;
  evidenceLimits: EvidenceLimits;
  rerankCandidates: number;
  rerankTopN: number;
}

export type AnswerPipeline = ReturnType<typeof createAnswerPipeline>;

/** Which model and prompt version served each role; stored on the assistant message. */
export interface AnswerMeta {
  models: Record<string, { key: string; modelId: string }>;
  promptVersions: Record<string, string>;
}

export interface PresignedUpload {
  url: string;
  key: string;
  contentType: string;
  expiresAt: string;
  maxBytes: number;
}

export interface UploadPresigner {
  createPut(params: {
    contentType: string;
    sizeBytes: number;
    filename: string;
  }): Promise<PresignedUpload>;
}

export interface IngestionExecutor {
  start(jobId: IngestionJobId): Promise<void>;
}

export interface AppContext {
  config: AppConfig;
  clock: Clock;
  ids: IdGenerator;
  games: GamesRepository;
  sessions: SessionsRepository;
  messages: MessagesRepository;
  documents: DocumentsRepository;
  chunks: ChunksRepository;
  ingestionJobs: IngestionJobsRepository;
  rawStore: S3ObjectStore;
  normalizedStore: S3ObjectStore;
  presigner: UploadPresigner;
  executor: IngestionExecutor;
  answerPipeline: AnswerPipeline;
  answerMeta: AnswerMeta;
}

function requireEnv(key: string, env: Record<string, string | undefined> = process.env): string {
  const v = env[key];
  if (!v || v.length === 0) {
    throw new Error(`missing required env var: ${key}`);
  }
  return v;
}

const ALLOWED_UPLOAD_MIME = new Set<string>([
  'application/pdf',
  'text/html',
  'application/xhtml+xml',
]);

export function isAllowedUploadContentType(contentType: string): boolean {
  return ALLOWED_UPLOAD_MIME.has(contentType.toLowerCase());
}

export function loadConfigFromEnv(): AppConfig {
  const arn = process.env['INGESTION_STATE_MACHINE_ARN'];
  return {
    gamesTable: requireEnv('GAMES_TABLE'),
    contentTable: requireEnv('CONTENT_TABLE'),
    sessionsTable: requireEnv('SESSIONS_TABLE'),
    messagesTable: requireEnv('MESSAGES_TABLE'),
    documentsTable: requireEnv('DOCUMENTS_TABLE'),
    chunksTable: requireEnv('CHUNKS_TABLE'),
    ingestionJobsTable: requireEnv('INGESTION_JOBS_TABLE'),
    sessionTtlSeconds: Number(process.env['SESSION_TTL_SECONDS'] ?? 60 * 60 * 24),
    allowedOrigin: requireEnv('ALLOWED_ORIGIN'),
    ingestionBucket: requireEnv('INGESTION_BUCKET'),
    uploadMaxBytes: Number(process.env['UPLOAD_MAX_BYTES'] ?? 50 * 1024 * 1024),
    presignExpirySeconds: Number(process.env['PRESIGN_EXPIRY_SECONDS'] ?? 600),
    region: process.env['AWS_REGION'] ?? 'ap-southeast-1',
    ...(arn ? { ingestionStateMachineArn: arn } : {}),
  };
}

/** A required env var holding a finite number > 0 (an integer when `integer`). */
function requirePositiveNumber(
  key: string,
  env: Record<string, string | undefined>,
  integer = true,
) {
  const raw = requireEnv(key, env);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(
      `${key} must be a positive ${integer ? 'integer' : 'number'}; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export function loadAnsweringConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AnsweringConfig {
  return {
    usageTable: requireEnv('USAGE_TABLE', env),
    dailyAiCapUsd: requirePositiveNumber('DAILY_AI_CAP_USD', env, false),
    modelRequestTimeoutMs: requirePositiveNumber('MODEL_REQUEST_TIMEOUT_MS', env),
    evidenceLimits: {
      simple: requirePositiveNumber('EVIDENCE_LIMIT_SIMPLE', env),
      complex: requirePositiveNumber('EVIDENCE_LIMIT_COMPLEX', env),
    },
    rerankCandidates: requirePositiveNumber('RERANK_CANDIDATES', env),
    rerankTopN: requirePositiveNumber('RERANK_TOP_N', env),
  };
}

export function answerMetaFor(catalog = loadModelCatalog()): AnswerMeta {
  const entry = (role: 'router' | 'reranker' | 'answerer') => {
    const m = modelFor(catalog, role);
    return { key: m.key, modelId: m.modelId };
  };
  return {
    models: { router: entry('router'), reranker: entry('reranker'), answerer: entry('answerer') },
    promptVersions: {
      router: ROUTER_PROMPT_VERSION,
      reranker: RERANKER_PROMPT_VERSION,
      answerer: ANSWERER_PROMPT_VERSION,
    },
  };
}

interface PipelineParts {
  config: AnsweringConfig;
  documents: DocumentsRepository;
  ddb: DynamoDBClient;
}

/** Real Bedrock, S3 Vectors and DynamoDB behind the answer pipeline. */
function buildAnswerPipeline({ config, documents, ddb }: PipelineParts): AnswerPipeline {
  const logger = createLogger({ base: { app: 'bgr-api' } });
  setUnroutedCallListener((record) =>
    logger.error('model call outside an answer run', { ...record }),
  );

  const catalog = loadModelCatalog();
  const model = new ConverseStructuredModel({
    onCall: recordModelCall,
    requestTimeoutMs: config.modelRequestTimeoutMs,
  });
  const vectors = vectorSettingsFromEnv(process.env);
  const retriever = new VectorRulesRetriever({
    embeddings: new TitanEmbeddingsProvider(vectors.embedding),
    index: new S3VectorIndex(vectors.index),
    documents,
    topK: config.rerankCandidates,
  });

  return createAnswerPipeline({
    classifier: createQuestionClassifier(model, modelFor(catalog, 'router')),
    retriever,
    ranker: createPassageRanker(model, modelFor(catalog, 'reranker'), {
      maxRanked: config.rerankTopN,
    }),
    answerer: createRulesAnswerer(model, modelFor(catalog, 'answerer')),
    sources: async (chunks) => {
      const docs = new Map<string, Awaited<ReturnType<DocumentsRepository['getDocument']>>>();
      for (const id of new Set(chunks.map((c) => c.documentId))) {
        docs.set(id, await documents.getDocument(asSourceDocumentId(id)));
      }
      const out = new Map<string, SourceRecord>();
      for (const c of chunks) {
        const doc = docs.get(c.documentId);
        if (!doc) {
          logger.warn('chunk dropped: its document is missing', {
            chunkId: c.chunkId,
            documentId: c.documentId,
          });
          continue;
        }
        out.set(c.chunkId, {
          chunkId: c.chunkId,
          authority: doc.authority,
          provenance: doc.provenance,
          title: doc.title,
          sourceType: doc.sourceType,
          ...(doc.version === undefined ? {} : { version: doc.version }),
        });
      }
      return out;
    },
    ledger: new DynamoSpendLedger(ddb, { usageTable: config.usageTable }),
    dailyCapUsd: config.dailyAiCapUsd,
    limits: config.evidenceLimits,
    now: () => new Date(),
    logger,
  });
}

let cached: AppContext | undefined;

export function getContext(): AppContext {
  if (cached) return cached;
  const config = loadConfigFromEnv();
  const ddb = new DynamoDBClient({});
  const sfn = new SFNClient({ region: config.region });
  const rawStore = new S3ObjectStore({ bucket: config.ingestionBucket, region: config.region });
  const normalizedStore = rawStore;

  const presigner = createS3UploadPresigner({
    bucket: config.ingestionBucket,
    region: config.region,
    expirySeconds: config.presignExpirySeconds,
    maxBytes: config.uploadMaxBytes,
  });

  const executor: IngestionExecutor = {
    async start(jobId) {
      if (!config.ingestionStateMachineArn) {
        // Dev-only local fallback — no state machine configured. The
        // Lambda cold-path never sees this because CDK always sets the ARN.
        // Left in for the unit-test path.
        return;
      }
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: config.ingestionStateMachineArn,
          name: `ingestion-${jobId}-${Date.now()}`,
          input: JSON.stringify({ jobId }),
        }),
      );
    },
  };

  const documents = new DynamoDocumentsRepository(ddb, { documentsTable: config.documentsTable });
  // Built on the first question, so routes that never answer need none of its env.
  let pipeline: AnswerPipeline | undefined;
  const answerPipeline: AnswerPipeline = {
    answer: (input, onCall) => {
      pipeline ??= buildAnswerPipeline({
        config: loadAnsweringConfigFromEnv(),
        documents,
        ddb,
      });
      return pipeline.answer(input, onCall);
    },
  };

  cached = {
    config,
    clock: systemClock,
    ids: cryptoIdGenerator,
    games: new DynamoGamesRepository(ddb, {
      gamesTable: config.gamesTable,
      contentTable: config.contentTable,
    }),
    sessions: new DynamoSessionsRepository(ddb, { sessionsTable: config.sessionsTable }),
    messages: new DynamoMessagesRepository(ddb, { messagesTable: config.messagesTable }),
    documents,
    chunks: new DynamoChunksRepository(ddb, { chunksTable: config.chunksTable }),
    ingestionJobs: new DynamoIngestionJobsRepository(ddb, {
      ingestionJobsTable: config.ingestionJobsTable,
    }),
    rawStore,
    normalizedStore,
    presigner,
    executor,
    answerPipeline,
    answerMeta: answerMetaFor(),
  };
  return cached;
}

export function overrideContextForTests(ctx: AppContext): void {
  cached = ctx;
}

export function resetContextForTests(): void {
  cached = undefined;
}
