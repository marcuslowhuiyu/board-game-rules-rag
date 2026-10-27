/**
 * Creates the eval games in dev and ingests their sources through the public
 * API, then writes the ids to config/eval-games.dev.json.
 *
 *   pnpm -C evals eval:ingest
 *
 * API_BASE overrides the dev API. Local files listed in eval-sources.json
 * (official FAQ PDFs) live outside the repo; `~` is expanded.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EvalSourcesSchema, ingestEvalGames } from '../src/ingest/plan.js';

const configPath = (name: string) => fileURLToPath(new URL(`../config/${name}`, import.meta.url));
const expandHome = (p: string) => (p.startsWith('~/') ? `${homedir()}${p.slice(1)}` : p);

const sources = EvalSourcesSchema.parse(
  JSON.parse(await readFile(configPath('eval-sources.json'), 'utf8')),
);
const games = await ingestEvalGames({
  apiBase: process.env['API_BASE'] ?? 'https://d1wbjv971ead09.cloudfront.net/api',
  sources,
  fetch,
  readLocal: async (p) => new Uint8Array(await readFile(expandHome(p))),
  poll: { intervalMs: 5_000, timeoutMs: 15 * 60_000 },
  log: (line) => process.stdout.write(`${line}\n`),
});
await writeFile(configPath('eval-games.dev.json'), JSON.stringify(games, null, 2) + '\n');
process.stdout.write('wrote config/eval-games.dev.json\n');
