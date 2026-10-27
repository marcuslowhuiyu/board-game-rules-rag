import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { TITAN_V2_DIMENSIONS, TitanEmbeddingsProvider, type TitanDimensions } from '@bgr/ai';
import { asEditionId, asGameId } from '@bgr/domain';
import {
  DynamoChunksRepository,
  DynamoDocumentsRepository,
  DynamoGamesRepository,
} from '@bgr/persistence';
import { S3VectorIndex, VectorRulesRetriever, type VectorIndex } from '@bgr/retrieval';
import { z } from 'zod';
import type { EvalGames } from '../run-eval.js';
import type { CorpusChunk } from './local-index.js';

/**
 * Wiring for runs against the deployed dev stack. Settings come from env, the
 * same names the ingestion stage runner uses (ADR-0002); `scripts/dev-env.sh`
 * exports them from the stack. A missing value fails fast with its name.
 */
export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required env var: ${key} (source scripts/dev-env.sh)`);
  return v;
}

export function createDevDocuments(): DynamoDocumentsRepository {
  const region = process.env['VECTOR_REGION'] ?? 'ap-southeast-1';
  return new DynamoDocumentsRepository(new DynamoDBClient({ region }), {
    documentsTable: requireEnv('DOCUMENTS_TABLE'),
  });
}

/**
 * Titan with the stack's region and model. `dimensions` defaults to the
 * deployed EMBEDDING_DIMENSIONS; the local-index comparison overrides it.
 */
export function createTitanEmbeddings(dimensions?: number): TitanEmbeddingsProvider {
  const dims = dimensions ?? Number(requireEnv('EMBEDDING_DIMENSIONS'));
  if (!TITAN_V2_DIMENSIONS.includes(dims as TitanDimensions)) {
    throw new Error(`dimensions must be one of ${TITAN_V2_DIMENSIONS.join(', ')}; got ${dims}`);
  }
  return new TitanEmbeddingsProvider({
    region: requireEnv('EMBEDDING_REGION'),
    modelId: requireEnv('EMBEDDING_MODEL_ID'),
    dimensions: dims as TitanDimensions,
  });
}

/**
 * A retriever over the deployed S3 Vectors index, or over `local.index` with
 * its embedder (the local-index comparison). Documents always come from dev.
 */
export function createDevRetriever(
  topK: number,
  local?: { index: VectorIndex; embeddings: TitanEmbeddingsProvider },
): VectorRulesRetriever {
  const region = process.env['VECTOR_REGION'] ?? 'ap-southeast-1';
  return new VectorRulesRetriever({
    embeddings: local?.embeddings ?? createTitanEmbeddings(),
    index: local?.index ?? new S3VectorIndex({ region, indexArn: requireEnv('VECTOR_INDEX_ARN') }),
    documents: createDevDocuments(),
    topK,
  });
}

const EvalGamesSchema = z.record(
  z.string(),
  z.object({
    gameId: z.string().min(1),
    editionId: z.string().min(1),
    content: z.record(z.string(), z.string()),
    chunks: z.number().int().nonnegative(),
  }),
);

export async function loadEvalGames(): Promise<EvalGames> {
  const path = fileURLToPath(new URL('../../config/eval-games.dev.json', import.meta.url));
  return EvalGamesSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/**
 * A chunk body from S3. A missing body throws, as the ingestion store's read
 * does, so the local index never embeds a header-only chunk.
 */
export async function readChunkBody(s3: Pick<S3Client, 'send'>, textUri: string): Promise<string> {
  const [, bucket, ...rest] = /^s3:\/\/([^/]+)\/(.+)$/.exec(textUri) ?? [];
  if (!bucket || rest.length === 0) throw new Error(`bad textUri ${textUri}`);
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: rest.join('/') }));
  if (!res.Body) throw new Error(`empty body reading ${textUri}`);
  return res.Body.transformToString('utf-8');
}

/**
 * Every chunk of each eval game's CURRENT documents, with its body and the
 * game and content names the EMBED stage puts in its header.
 */
export async function loadCorpus(games: EvalGames): Promise<Record<string, CorpusChunk[]>> {
  const region = process.env['VECTOR_REGION'] ?? 'ap-southeast-1';
  const ddb = new DynamoDBClient({ region });
  const documents = new DynamoDocumentsRepository(ddb, {
    documentsTable: requireEnv('DOCUMENTS_TABLE'),
  });
  const chunks = new DynamoChunksRepository(ddb, { chunksTable: requireEnv('CHUNKS_TABLE') });
  const catalog = new DynamoGamesRepository(ddb, {
    gamesTable: requireEnv('GAMES_TABLE'),
    contentTable: requireEnv('CONTENT_TABLE'),
  });
  const s3 = new S3Client({ region });

  const out: Record<string, CorpusChunk[]> = {};
  for (const [key, game] of Object.entries(games)) {
    const gameId = asGameId(game.gameId);
    const gameName = (await catalog.getGame(gameId))?.name;
    if (!gameName) throw new Error(`game ${game.gameId} not found in GAMES_TABLE`);
    const contentNames = new Map(
      (await catalog.listContent(gameId)).map((c) => [c.contentId as string, c.name]),
    );
    const docs = await documents.listDocumentsForEdition(gameId, asEditionId(game.editionId));
    out[key] = [];
    for (const doc of docs.filter((d) => d.status === 'CURRENT')) {
      const contentName = contentNames.get(doc.contentId);
      if (!contentName) throw new Error(`content ${doc.contentId} not found in CONTENT_TABLE`);
      for (const chunk of await chunks.listChunksForDocument(doc.documentId)) {
        const text = await readChunkBody(s3, chunk.textUri);
        out[key].push({ chunk, text, gameName, contentName });
      }
    }
  }
  return out;
}

/** Text and heading path of every chunk in each eval game's CURRENT documents. */
export async function loadGameChunks(
  games: EvalGames,
): Promise<Record<string, Array<{ text: string; headingPath: string[] }>>> {
  const corpus = await loadCorpus(games);
  return Object.fromEntries(
    Object.entries(corpus).map(([key, chunks]) => [
      key,
      chunks.map((c) => ({ text: c.text, headingPath: c.chunk.headingPath })),
    ]),
  );
}
