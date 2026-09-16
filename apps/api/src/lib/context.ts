import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoGamesRepository,
  DynamoMessagesRepository,
  DynamoSessionsRepository,
  cryptoIdGenerator,
  systemClock,
  type Clock,
  type GamesRepository,
  type IdGenerator,
  type MessagesRepository,
  type SessionsRepository,
} from '@bgr/persistence';

export interface AppConfig {
  gamesTable: string;
  contentTable: string;
  sessionsTable: string;
  messagesTable: string;
  sessionTtlSeconds: number;
  allowedOrigin: string;
}

export interface AppContext {
  config: AppConfig;
  clock: Clock;
  ids: IdGenerator;
  games: GamesRepository;
  sessions: SessionsRepository;
  messages: MessagesRepository;
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(`missing required env var: ${key}`);
  }
  return v;
}

export function loadConfigFromEnv(): AppConfig {
  return {
    gamesTable: requireEnv('GAMES_TABLE'),
    contentTable: requireEnv('CONTENT_TABLE'),
    sessionsTable: requireEnv('SESSIONS_TABLE'),
    messagesTable: requireEnv('MESSAGES_TABLE'),
    sessionTtlSeconds: Number(process.env['SESSION_TTL_SECONDS'] ?? 60 * 60 * 24),
    allowedOrigin: requireEnv('ALLOWED_ORIGIN'),
  };
}

let cached: AppContext | undefined;

export function getContext(): AppContext {
  if (cached) return cached;
  const config = loadConfigFromEnv();
  const ddb = new DynamoDBClient({});
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
  };
  return cached;
}

export function overrideContextForTests(ctx: AppContext): void {
  cached = ctx;
}

export function resetContextForTests(): void {
  cached = undefined;
}
