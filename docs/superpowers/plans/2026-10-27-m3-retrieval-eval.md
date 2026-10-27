# M3 slice 4: Retrieval Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A two-tier retrieval eval made of four parts:
- a validated JSONL dataset;
- scoring;
- a runner against dev;
- an AWS-free regression subset that runs inside `pnpm test`.

The eval runs over fresh eval games that include the official FAQs.

**Architecture:** Everything lives in the existing `@bgr/evals` workspace package.
- **Pure core:** schema, matching, scoring, aggregation and markdown. It depends only on `RetrievedChunk` from `@bgr/retrieval`.
- **Orchestration:** `runEval` takes a `RulesRetriever` per game, so the same code runs in two places:
  - in tests, with `InMemoryVectorIndex` and a hash embedder;
  - live, with `VectorRulesRetriever`, `S3VectorIndex` and Titan.
- **Scripts:** two thin `tsx` scripts. One creates and ingests the eval games through the public API; the other runs the live eval.

**Tech Stack:** TypeScript strict (`tsconfig.base.json`), zod 4, Vitest 4, tsx, Node 22 (`nvm use`; the local default is Node 20).

**Spec:** `docs/superpowers/specs/2026-10-27-m3-retrieval-eval-design.md`. Case candidates are in `docs/superpowers/specs/2026-10-27-m3-retrieval-eval-candidates.md`.

## Global Constraints

- Simple tier: a simple case has exactly one required item. Bar: required evidence in the top 3 for ≥ 90 % of simple cases.
- Complex tier: two or more required items. Bar: every required item in the top 10 for ≥ 70 % of complex cases.
- Games whose eval ingest has fewer than 30 chunks are excluded from the tier bars. They are still reported, marked "small corpus". The threshold is config.
- Evidence is matched by key phrase, and by heading when one is given. It is never matched by chunk id.
- Matching normalises the text first:
  - case-insensitive;
  - collapses whitespace;
  - collapses letter-spaced words such as "L AUNCH" → "launch";
  - treats curly quotes as straight quotes.
- Real rulebook text never enters the repo. The dataset stores only key phrases of 15 words or fewer. Regression fixtures are synthetic.
- Each document in an eval game has a distinct `sourceType`, and the ingest script asserts this before uploading. Assignments are in the spec's Source types table.
- Model id, region, dimension, `topK` and the vector index ARN come from config or env, never from code.
- Eval case questions are paraphrased, and each case links to its BGG thread. No requests go to BGG's internal API (`api.geekdo.com`).
- Reports go to `evals/reports/`, which is already gitignored.
- The subset adds no CI workflow and no AWS or network access. It runs inside the existing `pnpm test` (ADR-0009).

## Review Focus

1. **An evidence phrase that spans a chunk boundary** never matches, so the case fails for ever. Task 6's verifier must report "phrase not found in any single chunk" before a case is committed.
2. **The retriever returns fewer than k results, or none** (no CURRENT documents, or a filter mismatch). The case scores 0, with no crash. The report counts empty retrievals per game. Covered by Task 2.
3. **Several chunks match one item, or one chunk matches several items.** Each item is counted once, at its best rank. A chunk may satisfy several items. Covered by Task 2.
4. **Typographic differences between the dataset and the extracted text** (`don't` vs `don’t`, letter-spaced headings, line breaks inside a phrase) must still match. Covered by Task 2.
5. **A stale or missing eval-games config** (a game was deleted, or a case names an unknown game) fails fast with a message naming the game. It must not silently score zeros. Covered by Task 4.

---

### Task 1: Package setup, case schema and dataset loader

**Files:**
- Modify: `evals/package.json`. Add:
  - scripts `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`, `"eval:retrieval": "tsx run-retrieval-eval.ts"` and `"eval:ingest": "tsx scripts/ingest-eval-games.ts"`;
  - deps `@bgr/retrieval`, `@bgr/ai`, `@bgr/persistence` and `@bgr/domain` (all `workspace:*`), plus `zod` `^4.6.7` and `@aws-sdk/client-dynamodb`, matching `packages/persistence`;
  - devDeps `tsx`, `vitest` `^4.1.12` and `typescript` `^5.6.2`.
- Create: `evals/tsconfig.json`. Extend `../tsconfig.base.json` with `noEmit` and include `src`, `scripts` and `*.ts`.
- Create: `evals/src/dataset/case-schema.ts`
- Test: `evals/src/dataset/case-schema.test.ts`

**Interfaces:**
- Produces:
  - `EvidenceItemSchema` / `EvidenceItem`: `{ key: string; phrase: string (1–120 chars, ≤ 15 words); heading?: string; required: boolean; authority?: Authority }`.
  - `RetrievalCaseSchema` / `RetrievalCase`: `{ id: string (kebab); game: string; edition: string; enabledContent: string[] (min 1); tier: 'simple' | 'complex'; question: string; requiredEvidence: EvidenceItem[] (min 1); source: { url: string (url); title: string }; notes?: string; futureEvidence?: unknown[] }`. A refinement checks the tier against the required count: `simple` needs exactly one item with `required: true`, and `complex` needs at least two.
  - `loadDataset(paths: string[]): Promise<RetrievalCase[]>` validates every line. On the first bad line it throws `DatasetError`, naming the file, the line number and the zod issue. It also throws on a duplicate `id` across files.

- [ ] **Step 1: Write the failing tests.**
  - `accepts a simple case with one required item`
  - `rejects a simple case with two required items` (expect `/simple.*exactly one required/`)
  - `rejects a complex case with one required item`
  - `rejects a phrase over 15 words`
  - `loadDataset reports file and line of a malformed line` (expect the message to contain `bad.jsonl:2`)
  - `loadDataset rejects duplicate ids across files`

  The tests write temporary JSONL files to `os.tmpdir()`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm -C evals test`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `case-schema.ts` per the Interfaces block. Use zod `superRefine` for the tier rule.
- [ ] **Step 4: Run the gates.** `pnpm install && pnpm -C evals test && pnpm -C evals typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(m3-s4): eval case schema and dataset loader`

### Task 2: Evidence matching and per-case scoring

**Files:**
- Create: `evals/src/scoring/match.ts` and `evals/src/scoring/score-case.ts`
- Test: `evals/src/scoring/match.test.ts` and `evals/src/scoring/score-case.test.ts`

**Interfaces:**
- Consumes: `RetrievalCase` and `EvidenceItem` (Task 1), and `RetrievedChunk` (from `@bgr/retrieval`).
- Produces:
  - `normalize(text: string): string`
  - `evidenceMatches(item: EvidenceItem, chunk: Pick<RetrievedChunk, 'text' | 'headingPath'>): boolean`. The normalised phrase must be a substring of the normalised text. When `heading` is set, some entry of the normalised `headingPath` must contain the normalised heading.
  - `scoreCase(c: RetrievalCase, ranked: readonly RetrievedChunk[]): CaseResult`, where `CaseResult = { id; game; tier; retrieved: number; itemRanks: Record<string, number | null> /* 1-based best rank per item key, required and supporting */; recallAt: Record<1|3|5|10, number> /* share of REQUIRED items found within k */; fullCoverageAt: Record<1|3|5|10, boolean>; reciprocalRank: number /* 1/rank of first required item, else 0 */; irrelevantTop5: number /* share of top-5 chunks matching no item */ }`.

**Letter-spacing:** collapse any run of two or more tokens, each one to three uppercase letters, by joining them. "L AUNCH A PROBE" → "LAUNCH A PROBE" → "launch a probe". Apply this before lowercasing. The test pins the behaviour.

- [ ] **Step 1: Write the failing tests.**
  - `normalize` cases:
    - `'Don’t  forget\nto ROTATE'` → `"don't forget to rotate"`;
    - `'L AUNCH A PROBE'` → `'launch a probe'`;
    - `'BET WEEN ROUNDS'` → `'between rounds'`.
  - `evidenceMatches`:
    - matches across a line break in the chunk;
    - fails when the heading is set but absent from `headingPath`;
    - passes when the heading is unset.
  - `scoreCase`:
    - `simple case hit at rank 2`: `recallAt[1]=0`, `recallAt[3]=1`, `reciprocalRank=0.5`.
    - `complex case with 2 of 3 required in top 10`: `recallAt[10]≈0.667`, `fullCoverageAt[10]=false`.
    - `supporting items reported but not counted`: the supporting item has a rank, while `recallAt` counts only required items.
    - `one chunk satisfies two items`: both ranks equal that chunk's rank.
    - `item matched by several chunks takes best rank`.
    - `empty retrieval scores zero`: `retrieved=0`, all `recallAt` 0, `reciprocalRank=0`, `irrelevantTop5=0`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm -C evals test`. Expected: FAIL.
- [ ] **Step 3: Implement** `match.ts` and `score-case.ts` per the Interfaces block.
- [ ] **Step 4: Run them and see them pass.** `pnpm -C evals test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(m3-s4): evidence matching and per-case retrieval scoring`

### Task 3: Aggregation, tier bars and markdown

**Files:**
- Create: `evals/src/scoring/aggregate.ts`, `evals/src/report/markdown.ts` and `evals/config/eval.config.json`
- Test: `evals/src/scoring/aggregate.test.ts` and `evals/src/report/markdown.test.ts`

**Interfaces:**
- Consumes: `CaseResult` (Task 2).
- Produces:
  - `EvalConfig = { topK: number; smallCorpusThreshold: number; bars: { simple: { k: 3; minRate: 0.9 }; complex: { k: 10; minRate: 0.7 } } }`. It is loaded from `evals/config/eval.config.json` with the values `{ "topK": 15, "smallCorpusThreshold": 30, "bars": { "simple": { "k": 3, "minRate": 0.9 }, "complex": { "k": 10, "minRate": 0.7 } } }`.
  - `aggregate(results: CaseResult[], corpusSize: Record<string, number>, config: EvalConfig): EvalReport`, where `EvalReport = { generatedAt: string; config: EvalConfig; games: GameRow[]; tiers: { simple: TierRow; complex: TierRow }; cases: CaseResult[] }`.
    - `GameRow = { game; chunks; smallCorpus: boolean; cases; emptyRetrievals; recallAt1; recallAt3; recallAt5; mrr; irrelevantRate; simplePassRate; complexFullCoverageRate }`.
    - `TierRow = { cases: number /* excluding small-corpus games */; passRate: number; bar: number; passed: boolean }`.
    - A simple case passes when `fullCoverageAt[3]`. A complex case passes when `fullCoverageAt[10]`.
  - `toMarkdown(report: EvalReport): string`. It produces:
    - a per-game table, with columns Game | Chunks | Cases | R@1 | R@3 | R@5 | MRR | Irrelevant | Simple pass | Complex full coverage, and small-corpus rows suffixed ` (small corpus)`;
    - a tier table with a ✅ or ❌ against each bar;
    - a list of failed case ids per tier.

- [ ] **Step 1: Write the failing tests.**
  - `tier pass rate excludes small-corpus games`: a 7-chunk game with all cases passing does not lift a failing tier.
  - `tier passed when rate meets bar exactly` (0.9 vs 0.9).
  - `game row averages recall and MRR over that game's cases`.
  - `markdown marks small-corpus rows and failed tiers`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm -C evals test`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block. Read the config with zod validation (`EvalConfigSchema`).
- [ ] **Step 4: Run them and see them pass.** `pnpm -C evals test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(m3-s4): per-game and per-tier aggregation with markdown report`

### Task 4: `runEval` and the synthetic regression subset

**Files:**
- Create:
  - `evals/src/run-eval.ts`
  - `evals/src/testing/hash-embedder.ts`
  - `evals/fixtures/retrieval/synthetic-corpus.json`
  - `evals/fixtures/retrieval/synthetic-cases.jsonl`
- Test: `evals/src/run-eval.test.ts` (this is the PR regression subset)

**Interfaces:**
- Consumes: `RulesRetriever`, `RetrievalQuery`, `VectorRulesRetriever` and `InMemoryVectorIndex` from `@bgr/retrieval`; `InMemoryDocumentsRepository` from `@bgr/persistence`; and `EmbeddingsProvider` from `@bgr/ai`. Also `loadDataset`, `scoreCase` and `aggregate` from Tasks 1–3.
- Produces:
  - `EvalGames = Record<string /* game key */, { gameId; editionId; content: Record<string /* slug */, string /* contentId */>; chunks: number }>`.
  - `runEval(input: { cases: RetrievalCase[]; games: EvalGames; retriever: RulesRetriever; config: EvalConfig }): Promise<EvalReport>`.
    - It throws `EvalConfigError('unknown game "<key>" in case <id>')` before any query runs if a case names a game, or content slug, that is missing from `games`.
    - Cases run sequentially, so Titan quota is not a concern.
  - `HashEmbedder implements EmbeddingsProvider` (`modelId: 'hash-bow-v1'`, `dimensions: 256`). It is deterministic:
    - lowercase and split on non-letters;
    - drop tokens shorter than 3 characters;
    - add 1 to `vec[fnv1a(token) % 256]`;
    - L2-normalise.

**Synthetic corpus:** about 12 invented rules for a made-up game, "Starfall". All text is original. Include:
- a CURRENT base rulebook, of at least 3 sections;
- a CURRENT `FAQ`/`OFFICIAL_ERRATA` document;
- a SUPERSEDED old rulebook whose text deliberately matches one case's phrase;
- a disabled promo content package, which also deliberately matches.

The fixture lists documents and chunks. The test builds `InMemoryDocumentsRepository` and `InMemoryVectorIndex` from it.

Write about 6 cases:
- 4 simple;
- 2 complex, one of which needs a base rule plus the FAQ ruling.

- [ ] **Step 1: Write the failing tests.**
  - `subset meets both bars on the synthetic corpus`.
  - `superseded and disabled-promo chunks never appear in any case's ranked results`. This asserts on `documentId` and `contentId` across all `CaseResult`s; capture the ranked lists through a spy retriever wrapper.
  - `unknown game fails fast before querying`.
  - `hash embedder is deterministic and unit length`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm -C evals test`. Expected: FAIL.
- [ ] **Step 3: Implement** `run-eval.ts`, `hash-embedder.ts` and the fixtures. Tune the fixture wording, not the scoring, until the subset passes.
- [ ] **Step 4: Run the gates.** `pnpm -C evals test`, then the full `pnpm test`, which must show the evals package running its tests. Expected: PASS. Check that the evals tests take under 5 s.
- [ ] **Step 5: Commit.** `feat(m3-s4): runEval and AWS-free retrieval regression subset`

### Task 5: Eval games ingest script

**Files:**
- Create: `evals/scripts/ingest-eval-games.ts`, `evals/src/ingest/plan.ts` and `evals/config/eval-sources.json`
- Test: `evals/src/ingest/plan.test.ts`

**Interfaces:**
- Produces:
  - `EvalSourcesSchema`. Per game key: `{ name: string /* "SETI (eval)" */; edition: string; documents: Array<{ title; sourceType: SourceType; authority: Authority; local?: string /* path, gitignored, outside repo allowed */; url?: string }> }`. Exactly one of `local` or `url` must be set.
  - `assertDistinctSourceTypes(sources): void` throws, naming the game and the duplicated type.
  - `ingestEvalGames(opts: { apiBase: string; sources; fetch: typeof fetch; poll: { intervalMs: number; timeoutMs: number } }): Promise<EvalGames>`. It is idempotent:
    - it finds an existing game by `GET /games?q=<slug>` with an exact slug match, and creates one otherwise (`POST /games` with `initialEdition`);
    - it reads the base `contentId` from `GET /games/{id}/content`;
    - for a `local` source, it does `POST /uploads/presign` → `PUT` → `POST /ingestion` with `{ source: { kind: 'S3', s3Key, contentType, filename } }`;
    - for a `url` source, it does `POST /ingestion` with `{ source: { kind: 'URL', url } }`;
    - it polls `GET /ingestion/{jobId}` until `SUCCEEDED` or `FAILED`, and throws with the job's error on `FAILED`;
    - duplicates short-circuit server-side.

  The `chunks` count per game is the sum of `chunkCount` over its CURRENT documents, from `GET /games/{gameId}` / sources. The script writes `evals/config/eval-games.dev.json`.
- `eval-sources.json` holds the spec's Source types table. `local` paths point to `~/bgr-eval-sources/<file>`, outside the repo; the operator puts the PDFs there. The Wingspan rulepop and Stonemaier FAQ entries use `url`.

- [ ] **Step 1: Write the failing tests.**
  - `assertDistinctSourceTypes rejects two RULEBOOK docs in one game`.
  - `ingestEvalGames reuses an existing game by slug`.
  - `ingestEvalGames creates game then uploads, ingests and polls`. Use a fake `fetch` that records calls, and assert this order: presign → PUT → ingestion → poll.
  - `a FAILED job throws with its stage and message`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm -C evals test`. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block. The script entry reads `API_BASE` (default `https://d1wbjv971ead09.cloudfront.net/api`) and expands `~`.
- [ ] **Step 4: Run them and see them pass.** `pnpm -C evals test`. Expected: PASS.
- [ ] **Step 5: Run it live with the rulebooks only.**
  - Temporarily mark the FAQ PDF entries `"skip": true`, an optional field on each document that the script honours. The Stonemaier FAQ page is a URL and can go in now.
  - Run `pnpm -C evals eval:ingest`.
  - Expected: three games, all jobs `SUCCEEDED`, and `eval-games.dev.json` written. Ticket to Ride should report fewer than 30 chunks.
- [ ] **Step 6: Commit** the script, tests, `eval-sources.json` and `eval-games.dev.json`. Message: `feat(m3-s4): idempotent eval-games ingest via the public API`

### Task 6: Live runner, dataset verifier and the dataset

**Files:**
- Create: `evals/run-retrieval-eval.ts`, `evals/scripts/verify-dataset.ts` and `evals/src/dataset/verify.ts`
- Create: `evals/datasets/retrieval/seti.jsonl`, `ticket-to-ride.jsonl` and `wingspan.jsonl`
- Test: `evals/src/dataset/verify.test.ts`

**Interfaces:**
- Consumes: everything above, plus `TitanEmbeddingsProvider`, `S3VectorIndex`, `VectorRulesRetriever` and `DynamoDocumentsRepository`.
- Produces:
  - `verifyDataset(cases, chunksByGame: Record<string, Array<{ text; headingPath: string[] }>>): VerifyIssue[]`, where `VerifyIssue = { caseId; itemKey; problem: 'phrase-not-found' | 'heading-mismatch' | 'phrase-in-multiple-games' }`.
  - `verify-dataset.ts` loads chunks for each eval game. It lists the documents with `DynamoDocumentsRepository.listDocumentsForEdition`, keeps the CURRENT ones, and reads `normalized/<documentId>/*.txt` from S3. Bucket and table names come from env `INGESTION_BUCKET` and `DOCUMENTS_TABLE` (and `CHUNKS_TABLE` for heading paths). It prints the issues and exits 1 if there are any.
  - `run-retrieval-eval.ts [--markdown] [--games seti,wingspan]`:
    - builds `VectorRulesRetriever` from env (`EMBEDDING_REGION`, `EMBEDDING_MODEL_ID`, `EMBEDDING_DIMENSIONS`, `VECTOR_INDEX_ARN`, `DOCUMENTS_TABLE`, `VECTOR_REGION`), reusing `vectorSettingsFromEnv` semantics;
    - takes `topK` from `eval.config.json`;
    - writes `evals/reports/retrieval-<ISO timestamp>.json`;
    - with `--markdown`, also prints `toMarkdown`.

  A missing env var fails fast with its name.
- **Dataset:** build it from the candidates file. Take `keep` rows now, and `faq` rows once the FAQ PDFs are ingested. Re-tier by the required count. Use the spec's JSON shape.
  - Keys look like `<game>/<section>/<slug>`.
  - Phrases are taken from the fresh eval ingest, not the old dev chunk numbers.
  - Target about 45 cases, about one third complex.

- [ ] **Step 1: Write the failing tests.**
  - `verify flags a phrase found in no chunk`.
  - `verify flags a phrase split across two chunks` (half the phrase in each).
  - `verify passes a phrase present in one chunk with matching heading`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm -C evals test`. Expected: FAIL.
- [ ] **Step 3: Implement** `verify.ts` and both scripts.
- [ ] **Step 4: Run them and see them pass.** `pnpm -C evals test`. Expected: PASS.
- [ ] **Step 5: Write the dataset's keep cases**, then run `pnpm -C evals exec tsx scripts/verify-dataset.ts`. Fix or drop every issue. Expected: exit 0.
- [ ] **Step 6: Run the first live eval.** `pnpm -C evals eval:retrieval --markdown`. Expected: the run completes with no errors, and the table shows all three games, with Ticket to Ride marked small corpus. Whether the bars pass is a finding for slice 5, not a gate here.
- [ ] **Step 7: Commit** the dataset, scripts and verifier. Message: `feat(m3-s4): live retrieval eval runner, dataset verifier and initial dataset`
- [ ] **Step 8 (once the operator supplies the FAQ PDFs):**
  - unskip them in `eval-sources.json` and re-run `eval:ingest`;
  - add the `faq` cases, then run `verify-dataset` and `eval:retrieval --markdown`;
  - commit with the message `feat(m3-s4): official FAQ cases`.

### Task 7: Docs and handoff

**Files:**
- Modify: `evals/README.md`. Cover:
  - the dataset format;
  - how to add a case;
  - `eval:ingest`, `verify-dataset` and `eval:retrieval`;
  - the env vars;
  - the subset in `pnpm test`.
- Modify: `CURRENT_STATE.md`.
  - Mark slice 4 done.
  - Record the eval game ids and the first-run table.
  - Note the BGG access rule.
  - Point slice 5 at the baseline, 512 vs 1024, and the PDF heading decision.
- Modify: `docs/milestones/M3-embeddings-retrieval.md` only if the format differs from its deliverables wording.
- Decision (the spec left this to the builder): there is **no `workflow_dispatch` job** for the full eval in this slice. It is a documented local command, because CI minutes are tight (ADR-0009) and a dispatch job would also need AWS access via OIDC. Record this in `evals/README.md`.

- [ ] **Step 1: Update the docs.**
- [ ] **Step 2: Run the full local gate.** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm synth`. Expected: all pass.
- [ ] **Step 3: Commit.** `docs(m3-s4): eval usage and slice 4 state`
- [ ] **Step 4: Review the slice.**
  - Run the Codex review: `/codex:review --base main --background`.
  - Triage each finding as fixed or declined, per `CLAUDE.md`.
  - Then follow `superpowers:requesting-code-review`.
