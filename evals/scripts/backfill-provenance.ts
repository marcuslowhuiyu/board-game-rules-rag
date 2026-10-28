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
import { DynamoGamesRepository } from '@bgr/persistence';
import { z } from 'zod';
import { createDevDocuments, requireEnv } from '../src/live/aws.js';
import { applyBackfill, planBackfill, type BackfillEntry } from '../src/provenance/backfill.js';

const planPath = fileURLToPath(new URL('../reports/provenance-plan.json', import.meta.url));
const [command, file] = process.argv.slice(2);
const now = new Date().toISOString();
const documents = createDevDocuments();

if (command === 'plan') {
  const region = process.env['VECTOR_REGION'] ?? 'ap-southeast-1';
  const games = new DynamoGamesRepository(new DynamoDBClient({ region }), {
    gamesTable: requireEnv('GAMES_TABLE'),
    contentTable: requireEnv('CONTENT_TABLE'),
  });
  const entries: BackfillEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await games.searchGames({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const game of page.items) {
      for (const edition of game.editions) {
        const docs = await documents.listDocumentsForEdition(game.gameId, edition.editionId);
        entries.push(...planBackfill(docs, now));
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  await mkdir(fileURLToPath(new URL('../reports', import.meta.url)), { recursive: true });
  await writeFile(planPath, JSON.stringify(entries, null, 2) + '\n');
  for (const e of entries) {
    process.stdout.write(
      `${e.documentId}  ${e.title}  [${e.sourceType}, ${e.authority}]  ${e.canonicalUrl ?? '(upload)'}\n`,
    );
  }
  process.stdout.write(`${entries.length} entries; wrote ${planPath}\n`);
} else if (command === 'apply' && file) {
  const entries = z
    .array(z.custom<BackfillEntry>((v) => typeof v === 'object' && v !== null))
    .parse(JSON.parse(await readFile(file, 'utf8')));
  const result = await applyBackfill(entries, documents, now);
  process.stdout.write(`applied ${result.applied.length}: ${result.applied.join(', ')}\n`);
  for (const s of result.skipped) process.stdout.write(`skipped ${s.documentId}: ${s.reason}\n`);
} else {
  process.stderr.write('usage: provenance:backfill plan | apply <file>\n');
  process.exit(1);
}
