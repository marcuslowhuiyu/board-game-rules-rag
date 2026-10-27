import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { TITAN_V2_DIMENSIONS, TitanEmbeddingsProvider, type TitanDimensions } from '@bgr/ai';
import { asEditionId, asGameId } from '@bgr/domain';
import { DynamoChunksRepository, DynamoDocumentsRepository } from '@bgr/persistence';
import { S3VectorIndex, VectorRulesRetriever } from '@bgr/retrieval';
import { z } from 'zod';
import type { EvalGames } from '../run-eval.js';

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

export function createDevRetriever(topK: number): VectorRulesRetriever {
  const dimensions = Number(requireEnv('EMBEDDING_DIMENSIONS'));
  if (!TITAN_V2_DIMENSIONS.includes(dimensions as TitanDimensions)) {
    throw new Error(`EMBEDDING_DIMENSIONS must be one of ${TITAN_V2_DIMENSIONS.join(', ')}`);
  }
  const region = process.env['VECTOR_REGION'] ?? 'ap-southeast-1';
  return new VectorRulesRetriever({
    embeddings: new TitanEmbeddingsProvider({
      region: requireEnv('EMBEDDING_REGION'),
      modelId: requireEnv('EMBEDDING_MODEL_ID'),
      dimensions: dimensions as TitanDimensions,
    }),
    index: new S3VectorIndex({ region, indexArn: requireEnv('VECTOR_INDEX_ARN') }),
    documents: new DynamoDocumentsRepository(new DynamoDBClient({ region }), {
      documentsTable: requireEnv('DOCUMENTS_TABLE'),
    }),
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

/** Text and heading path of every chunk in each eval game's CURRENT documents. */
export async function loadGameChunks(
  games: EvalGames,
): Promise<Record<string, Array<{ text: string; headingPath: string[] }>>> {
  const region = process.env['VECTOR_REGION'] ?? 'ap-southeast-1';
  const ddb = new DynamoDBClient({ region });
  const documents = new DynamoDocumentsRepository(ddb, {
    documentsTable: requireEnv('DOCUMENTS_TABLE'),
  });
  const chunks = new DynamoChunksRepository(ddb, { chunksTable: requireEnv('CHUNKS_TABLE') });
  const s3 = new S3Client({ region });

  const out: Record<string, Array<{ text: string; headingPath: string[] }>> = {};
  for (const [key, game] of Object.entries(games)) {
    const docs = await documents.listDocumentsForEdition(
      asGameId(game.gameId),
      asEditionId(game.editionId),
    );
    out[key] = [];
    for (const doc of docs.filter((d) => d.status === 'CURRENT')) {
      for (const chunk of await chunks.listChunksForDocument(doc.documentId)) {
        const [, bucket, ...rest] = /^s3:\/\/([^/]+)\/(.+)$/.exec(chunk.textUri) ?? [];
        if (!bucket || rest.length === 0) throw new Error(`bad textUri ${chunk.textUri}`);
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: rest.join('/') }));
        out[key].push({
          text: (await res.Body?.transformToString('utf-8')) ?? '',
          headingPath: chunk.headingPath,
        });
      }
    }
  }
  return out;
}
