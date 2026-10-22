# Current State

_Last updated: 2026-10-22 (M2-R4 final-review fixes)_

## Current milestone

**Milestone 2 — Document Ingestion** (feature branch `feature/m02-document-ingestion`; PR #1 open — it was PR #7 before the repo was recreated). Second-round review fixes are tracked in `docs/milestones/M2-REVIEW-FIXES.md` as slices: R1, R2, R2b and R3 are done and reviewed. The final whole-PR review (Claude reviewer + Codex) judged it ready to merge with fixes; M2-R4 fixed those findings and has been reviewed. PR #1 is ready to leave draft and merge. R2b was added after an independent Codex review of R1+R2 found four P1 defects, including a stage-runner bundle that could not load. Do not advance to M3 until PR #1 merges AND the post-merge real-document acceptance checks pass on dev.

Spec: `docs/milestones/M2-document-ingestion.md`.
Architecture decision: `docs/adr/0008-document-ingestion-pipeline.md` (revised 2026-09-17).

## Completed work

- **Milestone 0 — Repository & Engineering Foundation.** Merged. See prior state.
- **Milestone 1 — Domain Model, Game Catalog & Sessions.** Merged as PR #6 / commit `6b50738`. Deployed dev remained green; every M1 acceptance check passed.

## Milestone 2 — what's on `feature/m02-document-ingestion`

### First-pass work (initial PR)

- Domain: `Chunk`, `IngestionJob`, `IngestionQualityReport` schemas; `SourceDocument` promoted to the full M2 shape (required `contentHash`, `rawObjectUri`, `origin`, `chunkCount`, `knowledgeRevision`, `pageCount?`); status enum `CURRENT | SUPERSEDED | ARCHIVED`; `Edition.knowledgeRevision`.
- Persistence: in-memory + DynamoDB repos for documents, chunks, ingestion jobs; `GamesRepository.bumpKnowledgeRevision` + `replaceEditions`.
- Ingestion package (`@bgr/ingestion`): heading-aware chunker, deterministic PDF text-layer parser (via `unpdf`), HTML parser (via `cheerio`), SSRF guard, content-hash utility, quality detector, classifier, `ObjectStore` seam.
- API: `POST /uploads/presign`, `POST /ingestion`, `GET /ingestion/{jobId}`, `GET /sources/{sourceId}`, `GET /sources/{sourceId}/chunks`. Ingestion pipeline as pure stage functions of `(job, StageContext)`.
- Infra: three DDB tables (documents / chunks / ingestionJobs), private S3 bucket, `IngestionStageRunnerFn`, Step Functions state machine.
- Frontend: `SourcesScreen` — presigned PUT + `POST /ingestion` for PDFs; URL paste; polls `GET /ingestion/{jobId}`.
- ADR-0008; hand-crafted fixtures under `evals/fixtures/ingestion/`.

### Review revisions applied 2026-09-17 (this commit)

1. **State machine short-circuit (R1).** Each stage now returns `{ terminal }`; a `Choice_After_<STAGE>` state routes terminal results (duplicate at FETCH, FINALIZE completion, already-terminal redelivery) straight to `SkipEmbedIndexInM2 → PipelineSucceeded`. The stage runner also refuses to re-run against a job whose `status` is already `SUCCEEDED` / `FAILED`. Covered by CDK tests (`Check_After_<STAGE>` + `MarkJobFailed_<STAGE>` present per stage) and pipeline tests (duplicate short-circuit, `alreadyTerminal: true` on redelivery).
2. **Failure-safe FINALIZE (R2).** `CHUNK` reserves `plannedDocumentId` and writes chunks (deterministic ids so retries overwrite) before `FINALIZE` touches authoritative state. `FINALIZE` uses `AtomicPublisher.publishDocument()` (new persistence interface) — DynamoDB `TransactWriteItems` puts the new `SourceDocument`, supersedes the previous CURRENT doc, and bumps the edition `knowledgeRevision` in a single transaction. `PublishConflictError` reasons map to typed recovery (`DOC_EXISTS` → resume as success; `PREV_NOT_CURRENT` / `GAME_STALE` → retry). `SourceDocument.status` is the authoritative currency source (retriever in M3 must join on it; `Chunk.isCurrent` was removed in M2-R2). Failure-injection tests cover: crash between CHUNK and FINALIZE, crash after publish but before job update (no double revision bump), forced NORMALIZE failure (edition + docs untouched).
3. **Dedup scope (R3).** `findByContentHash` now takes `contentId`. Regression test: identical bytes on `c_base` and `c_promo` publish two separate documents.
4. **SSRF redirect handling (R4).** `createUrlFetcher()` uses `redirect: 'manual'` and re-runs `assertUrlSafeForFetch` on each redirect target (up to 5 hops). Redirect loop detection. `SourceDocument.canonicalUrl` records the FINAL URL. Tests cover safe redirect, private-IP redirect rejection, second-hop hostname rejection, and loop detection. DNS-rebinding residual risk explicitly documented in ADR-0008.
5. **Quality gate (R5).** `PARSE` fails on zero blocks / likely scan / > 70 % empty pages. Full `IngestionQualityReport` persisted on `IngestionJob.qualityReport` and returned by `GET /ingestion/{jobId}`. `CHUNK` fails on zero chunks. Regression test confirms empty-parser output leaves `knowledgeRevision` unchanged.
6. **BatchWrite `UnprocessedItems` (R6).** `DynamoChunksRepository.putChunks` / `deleteChunksForDocument` loop with capped exponential backoff (max 6 attempts, 100 ms base, jitter). Throws if items remain. Covered by `aws-sdk-client-mock`-based test.
7. **State-machine failure path (R7).** Each stage's `Catch` goes through a per-stage `MarkJobFailed_<STAGE>` Lambda before the shared `PipelineFailed` state. `MarkJobFailedFn` writes `status = FAILED` with stage/message/code even when the stage runner itself never got to write its own `failJob` (Lambda service exception, timeout, SDK failure). Retry-policy claim narrowed to the specific `Lambda.*` errors we actually retry.
8. **`forceFailureStage` off the public schema (R8).** `CreateIngestionJobInputSchema` no longer carries `forceFailureStage`. `InternalCreateIngestionJobInputSchema` extends it for tests. The public `POST /ingestion` handler never reads it from the request body.
9. **Storage lifecycle (R9).** `raw/` and `normalized/` are retained (no `ExpirationInDays`). Per-job stage state moved out of `normalized/` (now at `stage-state/ingestion/{jobId}/*.json` after M2-R2), with a 7-day lifecycle expiration. `temporary/` catch-all expires after 1 day. Multipart cleanup on every prefix (3 days). CDK test enforces raw/ and normalized/ have no ExpirationInDays.
10. **Bucket CORS (R10).** Ingestion bucket CORS `AllowedOrigins` is pinned to the CloudFront `distributionDomainName` via a CfnBucket escape hatch after the distribution is constructed. Never `*`. CDK test asserts no `*` and that the origin references the distribution's domain.
11. **Deploy workflow smoke test (R11).** Now reads the actual `Edition.knowledgeRevision` from the games table before and after the duplicate ingestion and asserts equality. Also added: a `pdf-lib`-generated synthetic PDF test that exercises the real `createUnpdfExtractor()` end-to-end (`packages/ingestion/src/parsers/unpdf-extractor.test.ts`), so the deployed `unpdf` path is covered by CI, not only by the deploy smoke test.

### Second-round review fixes (`docs/milestones/M2-REVIEW-FIXES.md`)

**M2-R1 — Pipeline state correctness (done, reviewed).**

1. FINALIZE's job `SUCCEEDED` write is now the fourth item in the atomic-publish transaction (`PublishDocumentArgs.completedJob` + `expectedJobUpdatedAt`, new `JOB_STALE` conflict reason). No window where the document is CURRENT but the job is not SUCCEEDED. `failJob` also refuses to downgrade a SUCCEEDED job.
2. `GAME_STALE` / `PREV_NOT_CURRENT` / `JOB_STALE` throw `RetryableStageError`; the runner does not persist FAILED for them, and the FINALIZE task retries that error (3 attempts, 1 s/exp backoff) before the Catch path records FAILED.
3. `Check_After_<STAGE>` routes only `terminal && status = SUCCEEDED` to success; any other terminal result goes `TerminalNotSucceeded_<STAGE> → MarkJobFailed_<STAGE> → PipelineFailed`.
4. `MarkJobFailed` never overwrites a SUCCEEDED job.

Tests: Dynamo publisher (4-item transaction, `JOB_STALE` mapping), `MarkJobFailed` handler (RUNNING / FAILED / SUCCEEDED), pipeline (error after commit, rejected publish, each retryable reason, real `JOB_STALE`, FAILED redelivery), and structural CDK assertions on the Choice branches and the FINALIZE retrier.

**M2-R2 — Chunk idempotency and storage invariants (done, reviewed).**

1. CHUNK persists `plannedDocumentId` on the job before any chunk write; a retry reuses it.
2. CHUNK crash/retry tests: crash before the first chunk write (same id, no orphans), crash between S3 bodies and DDB `putChunks` (same keys rewritten, counts match), and a real `DynamoChunksRepository` against a mocked client returning `UnprocessedItems` (R6 loop persists every chunk, FINALIZE count matches).
3. Stage state moved to `stage-state/ingestion/{jobId}/*.json` so the 1-day `temporary/` rule no longer overrides its 7-day expiry. CDK test asserts effective TTL per key and that no prefix nests in another.
4. `Chunk.isCurrent` removed from the schema and the writer; currency is `SourceDocument.status` only.
5. `IngestionJob.pageCount` records the parser page count at CHUNK; FINALIZE publishes it (falls back to `max(chunk.pageEnd)` only for jobs chunked before this change).

219 tests total.

**M2-R2b — Deployability and consistency (done, reviewed).** Fixes the four Codex P1 findings. The stage-runner bundle could not load (`Dynamic require of "buffer"`); fixed with a shared `createRequire` banner, and a new CDK test imports every real bundle. Pipeline-driving DynamoDB reads are now strongly consistent. Failure writes go through an atomic `markFailedIfActive` conditional write, closing the downgrade race the R1 guard left open. 233 tests total.

**M2-R3 — Parse quality and final cleanup (done, reviewed).** Each item has a test that failed first.

1. PARSE fails on `garbledCharRatio > 0.05` (`GARBLED_EXTRACTION`) for every format.
2. The scan and empty-page gates apply only to PDF. A short, valid HTML page is accepted, and a short PDF is still rejected as `LIKELY_SCAN`.
3. PDF headings are detected on every line (unpdf's single-newline output had flattened all but the first heading per page).
4. Chunk queries follow `LastEvaluatedKey` for listing and deletion.
5. The URL fetcher enforces the size cap while streaming and cancels the body.
6. `POST /games` with an initial edition also creates a READY base content package, atomically with the game. The R3 Codex review caught a partial-create failure in the first version.
7. SourcesScreen resets the content package when the edition changes; the old code sent the previous edition's `contentId`.
8. SourcesScreen cancels the previous job's poll loop when a new job starts, and on unmount.

254 tests total. `main` was merged into the branch (CI-minimisation and repo-recreation changes).

**M2-R4 — Final-review fixes (done, reviewed).** Each item has a test that failed first.

1. Presigned uploads no longer embed an empty-body checksum. Before this fix, S3 would have rejected every real upload.
2. A StartExecution error can no longer downgrade a finished job.
3. The HTML parser keeps table, definition-list and bare-div text, and emits nested list items once.
4. Re-uploading a superseded version reinstates it as CURRENT, reusing its chunks, and bumps `knowledgeRevision`.
5. FETCH snapshots upload bytes under a content-addressed key.
6. FINALIZE reads the game before dedup, so concurrent identical uploads publish once.
7. The in-memory publisher is genuinely atomic.
8. The SSRF guard classifies bracketed IPv6 literals and hex-mapped IPv4.

The R4 Codex review caught two more problems, both fixed: a concurrent-reinstate race that would have failed the job, and layout tables whose cell paragraphs were fused together. 276 tests total. Deferred minor findings are listed in `docs/milestones/M2-REVIEW-FIXES.md` §M2-R4.

### What still MUST happen post-merge before M2 is closed

- Ingest two structurally different real PDF rulebooks through the deployed `unpdf` path in dev; inspect representative complete chunks (heading paths, page ranges, lists / rule numbers). Real rulebooks stay out of the repo.
- Ingest at least one source through the actual URL path in dev.
- Confirm modified-version superseding + `knowledgeRevision` increment in dev.

## Active decisions

Load-bearing decisions from `docs/adr/`:

- **ADR-0001** — TypeScript strict, Node 22 LTS, pnpm 10, CDK v2 TypeScript.
- **ADR-0002** — S3 Vectors initial vector store behind `RulesRetriever`.
- **ADR-0003** — `RulesModel` interface + Bedrock Converse adapter default.
- **ADR-0004** — DynamoDB full log + rolling summary + recent turns, 24h TTL.
- **ADR-0005** — Bounded `WebSearchProvider` loop with AgentCore adapter.
- **ADR-0006** — DynamoDB multi-table design for M1 entities.
- **ADR-0007** — Same-origin routing via CloudFront `/api/*` + first-party `SameSite=Lax` session cookie.
- **ADR-0008 (revised 2026-09-17; review-fix revisions 2026-10-21/22)** — Ingestion pipeline: Step Functions + one stage-runner Lambda + Choice-based short-circuit + `MarkJobFailed` failure path; deterministic PDF-first; `TransactWriteItems`-based atomic publish; content-hash dedup scoped to `(game, edition, contentId, hash)`; manual redirect SSRF handling; quality gate at PARSE; storage lifecycle keeps raw/ + normalized/ retained and expires only `stage-state/ingestion/` (7d) and `temporary/` (1d), with no nested rule prefixes; ingestion-bucket CORS pinned to the CloudFront domain.

## Known issues / open questions

Full tracker: `docs/CONTRADICTIONS_AND_GAPS.md`.

- **G3 / G4 (S3 Vectors and AgentCore regional availability in `ap-southeast-1`).** Still unverified. Not blocking M2. Verify before M3 / M6.
- **DNS rebinding on URL ingestion** — mitigated at validation time (resolved IPs re-checked) but the subsequent `fetch()` performs its own resolution; a custom `undici.Agent` with a pinned resolver would fully close this. Tracked as an M2 residual risk in ADR-0008 §SSRF.
- **No GSI on the documents table** — dev-scale scan with FilterExpression is fine at M2. Upgrade path noted.
- **Fallback parser is a stub** — `createStubFallbackParser` throws. OCR/AI deferred.
- **`InMemorySessionsRepository`'s TTL check uses wall-clock time** — tests that hardcode a past NOW would falsely see sessions as expired; worked around by using a far-future NOW. Consider clock-injecting in a later cleanup.
- **No static security analysis.** CodeQL was removed in ADR-0009 while the repo was private. The repo is now public (recreated 2026-10-21), so CodeQL is free and can be reinstated.
- **PDF heading heuristic vs. real rulebooks.** Line-level heading detection can promote a body line that matches the heuristic. Tune it during the real-rulebook acceptance run, along with the 5 % garbled threshold.

## Requires operator decision, if you want them

- **Branch protection on `main`.** Now available for free, because the repo is public. Requiring the `Lint / Typecheck / Test / Synth` check before merge would enforce the PR-and-CI workflow.
- **`AWS_REGION` for a possible second region** for S3 Vectors or AgentCore — pending G3 / G4 verification.

## Next expected work

Real-document acceptance in dev after PR #1 merges. Once those checks pass, advance to Milestone 3 — Embeddings, Retrieval & Evaluation Foundation. See `docs/milestones/M3-embeddings-retrieval.md`.
