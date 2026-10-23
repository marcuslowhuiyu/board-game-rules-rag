import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  DynamoChunksRepository,
  DynamoDocumentsRepository,
  DynamoGamesRepository,
  DynamoIngestionJobsRepository,
  DynamoMessagesRepository,
  DynamoSessionsRepository,
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
import type { IngestionJobId } from '@bgr/domain';
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
}

function requireEnv(key: string): string {
  const v = process.env[key];
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
    documents: new DynamoDocumentsRepository(ddb, { documentsTable: config.documentsTable }),
    chunks: new DynamoChunksRepository(ddb, { chunksTable: config.chunksTable }),
    ingestionJobs: new DynamoIngestionJobsRepository(ddb, {
      ingestionJobsTable: config.ingestionJobsTable,
    }),
    rawStore,
    normalizedStore,
    presigner,
    executor,
  };
  return cached;
}

export function overrideContextForTests(ctx: AppContext): void {
  cached = ctx;
}

export function resetContextForTests(): void {
  cached = undefined;
}
