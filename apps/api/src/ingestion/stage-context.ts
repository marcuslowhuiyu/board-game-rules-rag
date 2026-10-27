import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoAtomicPublisher,
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
import { TITAN_V2_DIMENSIONS, TitanEmbeddingsProvider, type TitanDimensions } from '@bgr/ai';
import { S3VectorIndex } from '@bgr/retrieval';
import { createLogger } from '@bgr/shared';
import { S3ObjectStore } from '../lib/s3-object-store.js';
import type { StageContext } from './pipeline.js';

type Env = Record<string, string | undefined>;

function requireEnv(key: string, env: Env = process.env): string {
  const v = env[key];
  if (!v || v.length === 0) throw new Error(`missing required env var: ${key}`);
  return v;
}

export interface VectorSettings {
  embedding: { region: string; modelId: string; dimensions: TitanDimensions; concurrency: number };
  index: { region: string; indexArn: string };
}

/** Embedding model and vector index settings, set by the CDK stack (ADR-0002). */
export function vectorSettingsFromEnv(env: Env): VectorSettings {
  const dimensions = Number(env['EMBEDDING_DIMENSIONS'] ?? '1024');
  if (!TITAN_V2_DIMENSIONS.includes(dimensions as TitanDimensions)) {
    throw new Error(
      `EMBEDDING_DIMENSIONS must be one of ${TITAN_V2_DIMENSIONS.join(', ')}; got ${env['EMBEDDING_DIMENSIONS']}`,
    );
  }
  return {
    embedding: {
      region: requireEnv('EMBEDDING_REGION', env),
      modelId: requireEnv('EMBEDDING_MODEL_ID', env),
      dimensions: dimensions as TitanDimensions,
      concurrency: Number(env['EMBEDDING_CONCURRENCY'] ?? '4'),
    },
    index: {
      region: env['VECTOR_REGION'] ?? env['AWS_REGION'] ?? 'ap-southeast-1',
      indexArn: requireEnv('VECTOR_INDEX_ARN', env),
    },
  };
}

let cached: StageContext | undefined;

export function getStageContext(): StageContext {
  if (cached) return cached;
  const bucket = requireEnv('INGESTION_BUCKET');
  const gamesTable = requireEnv('GAMES_TABLE');
  const documentsTable = requireEnv('DOCUMENTS_TABLE');
  const ingestionJobsTable = requireEnv('INGESTION_JOBS_TABLE');
  const vectors = vectorSettingsFromEnv(process.env);
  const ddb = new DynamoDBClient({});
  const store = new S3ObjectStore({
    bucket,
    region: process.env['AWS_REGION'] ?? 'ap-southeast-1',
  });

  cached = {
    now: () => new Date(),
    ids: cryptoIdGenerator,
    documents: new DynamoDocumentsRepository(ddb, { documentsTable }),
    chunks: new DynamoChunksRepository(ddb, {
      chunksTable: requireEnv('CHUNKS_TABLE'),
    }),
    jobs: new DynamoIngestionJobsRepository(ddb, { ingestionJobsTable }),
    games: new DynamoGamesRepository(ddb, {
      gamesTable,
      contentTable: requireEnv('CONTENT_TABLE'),
    }),
    publisher: new DynamoAtomicPublisher(ddb, {
      documentsTable,
      gamesTable,
      ingestionJobsTable,
    }),
    rawStore: store,
    normalizedStore: store,
    urlFetcher: createUrlFetcher(),
    s3Fetcher: createS3Fetcher(store),
    pdfParser: createPdfTextLayerParser(createUnpdfExtractor()),
    htmlParser: createHtmlParser(),
    embeddings: new TitanEmbeddingsProvider(vectors.embedding),
    vectorIndex: new S3VectorIndex(vectors.index),
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
