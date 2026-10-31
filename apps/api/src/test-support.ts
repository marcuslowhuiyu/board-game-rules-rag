import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { IngestionJobId } from '@bgr/domain';
import {
  InMemoryChunksRepository,
  InMemoryDocumentsRepository,
  InMemoryGamesRepository,
  InMemoryIngestionJobsRepository,
  InMemoryMessagesRepository,
  InMemorySessionsRepository,
  fixedClock,
  staticIdGenerator,
  type IdGenerator,
} from '@bgr/persistence';
import { InMemoryObjectStore } from '@bgr/ingestion';
import type { ModelCallRecord } from '@bgr/ai';
import type { AnswerRun } from './lib/answer-pipeline.js';
import type {
  AnswerPipeline,
  AppConfig,
  AppContext,
  IngestionExecutor,
  PresignedUpload,
  UploadPresigner,
} from './lib/context.js';

export function makeEvent(over: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  const method = (over.requestContext?.http?.method ?? 'GET') as string;
  const path = over.rawPath ?? '/';
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: over.rawQueryString ?? '',
    headers: over.headers ?? {},
    ...(over.body !== undefined ? { body: over.body } : {}),
    ...(over.cookies !== undefined ? { cookies: over.cookies } : {}),
    isBase64Encoded: over.isBase64Encoded ?? false,
    requestContext: {
      accountId: '000000000000',
      apiId: 'test',
      domainName: 'test.example.com',
      domainPrefix: 'test',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'req-1',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: '16/Sep/2026:00:00:00 +0000',
      timeEpoch: 1789603200000,
      ...(over.requestContext ?? {}),
    },
  } as APIGatewayProxyEventV2;
}

export interface FakePresigner extends UploadPresigner {
  calls: Array<{ contentType: string; sizeBytes: number; filename: string }>;
}

export interface FakeExecutor extends IngestionExecutor {
  started: IngestionJobId[];
  shouldFail: boolean;
}

export function makeFakePresigner(): FakePresigner {
  const calls: FakePresigner['calls'] = [];
  return {
    calls,
    async createPut({ contentType, sizeBytes, filename }): Promise<PresignedUpload> {
      calls.push({ contentType, sizeBytes, filename });
      return {
        url: `https://example.s3/put?sig=fake&k=${encodeURIComponent(filename)}`,
        key: `raw/2026-09-17/fake-${filename}`,
        contentType,
        expiresAt: '2026-09-17T00:10:00.000Z',
        maxBytes: 50 * 1024 * 1024,
      };
    },
  };
}

export function makeFakeExecutor(): FakeExecutor {
  const started: IngestionJobId[] = [];
  return {
    started,
    shouldFail: false,
    async start(jobId: IngestionJobId) {
      if (this.shouldFail) throw new Error('sfn start failed');
      started.push(jobId);
    },
  };
}

export interface FakePipeline extends AnswerPipeline {
  calls: Array<{ query: { text: string }; correlationId: string }>;
}

/** A pipeline returning `outcome` (with the documents it looked up), or throwing it when it is an Error; `records` go to `onCall`. */
export function makeFakePipeline(
  outcome: AnswerRun | Error,
  records: ModelCallRecord[] = [],
): FakePipeline {
  const calls: FakePipeline['calls'] = [];
  return {
    calls,
    async answer(input, onCall) {
      calls.push(input);
      for (const r of records) onCall(r);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

export function makeTestContext(
  overrides: {
    config?: Partial<AppConfig>;
    now?: string;
    ids?: Partial<IdGenerator>;
    presigner?: UploadPresigner;
    executor?: IngestionExecutor;
    rawStore?: InMemoryObjectStore;
    normalizedStore?: InMemoryObjectStore;
    answerPipeline?: AnswerPipeline;
  } = {},
): AppContext {
  const config: AppConfig = {
    gamesTable: 'games',
    contentTable: 'content',
    sessionsTable: 'sessions',
    messagesTable: 'messages',
    documentsTable: 'documents',
    chunksTable: 'chunks',
    ingestionJobsTable: 'ingestion-jobs',
    sessionTtlSeconds: 60 * 60 * 24,
    allowedOrigin: 'https://example.cloudfront.net',
    ingestionBucket: 'test-bucket',
    uploadMaxBytes: 50 * 1024 * 1024,
    presignExpirySeconds: 600,
    region: 'ap-southeast-1',
    ...overrides.config,
  };
  const clock = fixedClock(overrides.now ?? '2026-09-16T00:00:00.000Z');
  const baseIds = staticIdGenerator({
    gameId: 'g_test',
    editionId: 'e_test',
    contentId: 'c_test',
    sessionId: 's_test',
    messageId: 'm_test',
    sourceDocumentId: 'doc_test',
    chunkId: 'ch_test',
    ingestionJobId: 'job_test',
  });
  const ids: IdGenerator = { ...baseIds, ...overrides.ids };
  const rawStore = overrides.rawStore ?? new InMemoryObjectStore('test-bucket');
  const normalizedStore = overrides.normalizedStore ?? rawStore;
  return {
    config,
    clock,
    ids,
    games: new InMemoryGamesRepository(),
    sessions: new InMemorySessionsRepository(),
    messages: new InMemoryMessagesRepository(),
    documents: new InMemoryDocumentsRepository(),
    chunks: new InMemoryChunksRepository(),
    ingestionJobs: new InMemoryIngestionJobsRepository(),
    // Cast because the in-memory store isn't the S3ObjectStore type; the
    // handlers only touch the ObjectStore-compatible surface. See ADR-0008.
    rawStore: rawStore as unknown as AppContext['rawStore'],
    normalizedStore: normalizedStore as unknown as AppContext['normalizedStore'],
    presigner: overrides.presigner ?? makeFakePresigner(),
    executor: overrides.executor ?? makeFakeExecutor(),
    answerPipeline:
      overrides.answerPipeline ??
      ({
        answer: async () => {
          throw new Error('no answer pipeline in this test context');
        },
      } satisfies AnswerPipeline),
  };
}

export function bodyAs<T>(result: { body?: string | undefined }): T {
  if (!result.body) throw new Error('response has no body');
  return JSON.parse(result.body) as T;
}
