import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoChunksRepository,
  DynamoDocumentsRepository,
  DynamoGamesRepository,
  DynamoIngestionJobsRepository,
  cryptoIdGenerator,
} from '@bgr/persistence';
import {
  createHtmlParser,
  createPdfTextLayerParser,
  createS3Fetcher,
  createUnpdfExtractor,
  createUrlFetcher,
} from '@bgr/ingestion';
import { createLogger } from '@bgr/shared';
import { S3ObjectStore } from '../lib/s3-object-store.js';
import type { StageContext } from './pipeline.js';

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) throw new Error(`missing required env var: ${key}`);
  return v;
}

let cached: StageContext | undefined;

export function getStageContext(): StageContext {
  if (cached) return cached;
  const region = process.env['AWS_REGION'] ?? 'ap-southeast-1';
  const bucket = requireEnv('INGESTION_BUCKET');
  const ddb = new DynamoDBClient({});
  const rawStore = new S3ObjectStore({ bucket, region });
  const normalizedStore = rawStore;

  cached = {
    now: () => new Date(),
    ids: cryptoIdGenerator,
    documents: new DynamoDocumentsRepository(ddb, {
      documentsTable: requireEnv('DOCUMENTS_TABLE'),
    }),
    chunks: new DynamoChunksRepository(ddb, {
      chunksTable: requireEnv('CHUNKS_TABLE'),
    }),
    jobs: new DynamoIngestionJobsRepository(ddb, {
      ingestionJobsTable: requireEnv('INGESTION_JOBS_TABLE'),
    }),
    games: new DynamoGamesRepository(ddb, {
      gamesTable: requireEnv('GAMES_TABLE'),
      contentTable: requireEnv('CONTENT_TABLE'),
    }),
    rawStore,
    normalizedStore,
    urlFetcher: createUrlFetcher(),
    s3Fetcher: createS3Fetcher(rawStore),
    pdfParser: createPdfTextLayerParser(createUnpdfExtractor()),
    htmlParser: createHtmlParser(),
    logger: createLogger({ base: { app: 'bgr-ingestion' } }),
  };
  return cached;
}

export function overrideStageContextForTests(ctx: StageContext): void {
  cached = ctx;
}

export function resetStageContextForTests(): void {
  cached = undefined;
}
