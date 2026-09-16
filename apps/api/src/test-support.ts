import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  InMemoryGamesRepository,
  InMemoryMessagesRepository,
  InMemorySessionsRepository,
  fixedClock,
  staticIdGenerator,
  type IdGenerator,
} from '@bgr/persistence';
import type { AppConfig, AppContext } from './lib/context.js';

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

export function makeTestContext(
  overrides: {
    config?: Partial<AppConfig>;
    now?: string;
    ids?: Partial<IdGenerator>;
  } = {},
): AppContext {
  const config: AppConfig = {
    gamesTable: 'games',
    contentTable: 'content',
    sessionsTable: 'sessions',
    messagesTable: 'messages',
    sessionTtlSeconds: 60 * 60 * 24,
    allowedOrigin: 'https://example.cloudfront.net',
    ...overrides.config,
  };
  const clock = fixedClock(overrides.now ?? '2026-09-16T00:00:00.000Z');
  const baseIds = staticIdGenerator({
    gameId: 'g_test',
    editionId: 'e_test',
    contentId: 'c_test',
    sessionId: 's_test',
    messageId: 'm_test',
  });
  const ids: IdGenerator = { ...baseIds, ...overrides.ids };
  return {
    config,
    clock,
    ids,
    games: new InMemoryGamesRepository(),
    sessions: new InMemorySessionsRepository(),
    messages: new InMemoryMessagesRepository(),
  };
}

export function bodyAs<T>(result: { body?: string | undefined }): T {
  if (!result.body) throw new Error('response has no body');
  return JSON.parse(result.body) as T;
}
