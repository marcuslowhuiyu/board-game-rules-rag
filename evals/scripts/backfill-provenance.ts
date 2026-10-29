/**
 * Operator-confirmed provenance backfill for documents ingested before
 * provenance existed.
 *
 *   source evals/scripts/dev-env.sh
 *   pnpm -C evals provenance:backfill plan          # writes reports/provenance-plan.json
 *   (review each entry, set "confirmed": true on those you accept)
 *   pnpm -C evals provenance:backfill apply reports/provenance-plan.json
 *
 * Only confirmed entries are written, and only if the document is unchanged
 * since the plan. Applying twice is a no-op.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GameSchema } from '@bgr/domain';
import { z } from 'zod';
import { createDevDocuments, requireEnv } from '../src/live/aws.js';
import {
  applyBackfill,
  BackfillPlanSchema,
  planBackfill,
  scanAll,
  type BackfillEntry,
} from '../src/provenance/backfill.js';

const planPath = fileURLToPath(new URL('../reports/provenance-plan.json', import.meta.url));
const [command, file] = process.argv.slice(2);
const now = new Date().toISOString();
const documents = createDevDocuments();

if (command === 'plan') {
  const region = process.env['VECTOR_REGION'] ?? 'ap-southeast-1';
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const gamesTable = requireEnv('GAMES_TABLE');
  const games = (
    await scanAll<unknown, Record<string, unknown>>(async (startKey) => {
      const res = await ddb.send(
        new ScanCommand({
          TableName: gamesTable,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      return { items: res.Items ?? [], next: res.LastEvaluatedKey };
    })
  ).map((i) => GameSchema.parse(i));
  const entries: BackfillEntry[] = [];
  let examined = 0;
  for (const game of games) {
    for (const edition of game.editions) {
      const docs = await documents.listDocumentsForEdition(game.gameId, edition.editionId);
      examined += docs.length;
      entries.push(...planBackfill(docs, now));
    }
  }
  await mkdir(fileURLToPath(new URL('../reports', import.meta.url)), { recursive: true });
  await writeFile(planPath, JSON.stringify(entries, null, 2) + '\n');
  for (const e of entries) {
    process.stdout.write(
      `${e.documentId}  ${e.title}  [${e.sourceType}, ${e.authority}]  ${e.canonicalUrl ?? '(upload)'}\n`,
    );
  }
  process.stdout.write(
    `examined ${games.length} games, ${examined} documents; ${entries.length} entries; wrote ${planPath}\n`,
  );
} else if (command === 'apply' && file) {
  const parsed = BackfillPlanSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
  if (!parsed.success) {
    process.stderr.write(
      `plan file rejected, nothing written:\n${z.prettifyError(parsed.error)}\n`,
    );
    process.exit(1);
  }
  const result = await applyBackfill(parsed.data, documents, now);
  process.stdout.write(`applied ${result.applied.length}: ${result.applied.join(', ')}\n`);
  for (const s of result.skipped) process.stdout.write(`skipped ${s.documentId}: ${s.reason}\n`);
} else {
  process.stderr.write('usage: provenance:backfill plan | apply <file>\n');
  process.exit(1);
}
