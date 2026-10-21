# ADR-0008: Document ingestion — Step Functions + S3 + DynamoDB, deterministic PDF first

- **Status:** Accepted (revised 2026-09-17 after PR #7 review; revised 2026-10-21 for M2-R1 and M2-R2 review fixes)
- **Date:** 2026-09-17
- **Deciders:** Marcus Low, Claude Code (M2)
- **Related:** `MASTER_PLAN.md` §13, §14, §15, §16, §17, §18, §19, §46, §47, §48, §49, §51; Milestone 2; ADR-0001

## Context

Milestone 2 introduces the first content path into the system: rulebook PDFs and living-rules web pages get parsed, chunked, and stored with source/page/section provenance — but explicitly *without* embeddings or vector storage (those arrive in M3). The pipeline must be:

- observable per-stage (§47);
- idempotent and safely retryable;
- deduplicated per content package (§18);
- safe against SSRF for URL-based ingestion (§48, §17);
- failure-safe at publication (a partial FINALIZE must not become authoritative);
- deterministic-first for PDFs (§16, no automatic OCR/AI fallback until data justifies it).

M1 already established the domain types, DynamoDB access, and same-origin CloudFront routing. M2 is otherwise additive.

## Decision

### Orchestration

AWS Step Functions Standard workflow. Each of the eight M2 stages (`VALIDATE`, `FETCH`, `PARSE`, `CLASSIFY`, `DISCOVER_ERRATA`, `NORMALIZE`, `CHUNK`, `FINALIZE`) is a `LambdaInvoke` Task calling **the same** Node 22 Lambda (`ingestion-stage-runner`) with `{ jobId, stage }`. `EMBED` / `INDEX` are declared in a trailing `Pass` state and skipped in M2.

After every stage the state machine runs a `Choice` state on the runner's response, with two terminal branches:

- `$.terminal === true && $.status === 'SUCCEEDED'` (duplicate short-circuit at FETCH, FINALIZE completion, or an already-SUCCEEDED job on redelivery) → `SkipEmbedIndexInM2 → PipelineSucceeded`. This is what fixes the "duplicate ran every subsequent stage anyway" bug reported in the first PR review.
- `$.terminal === true` with any other status (e.g. redelivery of a stage against an already-FAILED job) → `TerminalNotSucceeded_<STAGE>` (a Pass that synthesises the `$.error` shape the Catch path produces) → `MarkJobFailed_<STAGE>` → `PipelineFailed`. A FAILED job can never end in a successful execution.

Non-terminal results continue to the next stage.

Every stage Task has a `Catch` to a per-stage `MarkJobFailed_<STAGE>` Lambda Task. That Lambda writes `status = FAILED`, `error.stage`, `error.message`, `error.code` to the job row before the `PipelineFailed` Fail state ends the execution — so a Lambda infrastructure failure (`Lambda.ServiceException`, `SdkClientException`, timeout) cannot leave a job stuck `RUNNING`. The retry policy is deliberately narrow (`Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`, `Lambda.TooManyRequestsException`, two attempts, 5 s/exp backoff) — application-level errors from the stage runner are NOT retried at the Step Functions level; the runner already writes its own `FAILED` record for those. The one exception is `RetryableStageError` on the FINALIZE task (see FINALIZE below): three attempts, 1 s/exp backoff, and the runner deliberately does not write `FAILED` for it.

`MarkJobFailed` is idempotent on `FAILED` (keeps the runner's more specific error) and **never overwrites `SUCCEEDED`**: if the runner's own write landed but Step Functions still took the Catch path (e.g. the invocation timed out after the commit), it logs the skip and leaves the job alone. The runner's own `failJob` has the same guard.

### Stage runner idempotency + already-terminal jobs

The runner checks `job.status` first. If the job is already `SUCCEEDED` or `FAILED` (Step Functions redelivery, at-least-once semantics), the runner returns `{ terminal: true }` without any side effects. The Choice state then routes on the job's status: SUCCEEDED to Succeed, FAILED through `MarkJobFailed` to Fail.

### State layout

- Job state: DynamoDB `IngestionJobs` table (partition key `jobId`).
- Intermediate stage artifacts: S3 under `stage-state/ingestion/{jobId}/*.json` (`fetch.json`, `parsed.json`, `normalized.json`, ...). Originally under `normalized/`, then `temporary/ingestion/…`; it now has its own top-level prefix so exactly one lifecycle rule applies (see Storage lifecycle).
- Chunk bodies: `normalized/{documentId}/{chunkId}.txt` (retained; the DDB chunk row references it).
- Raw sources: `raw/{yyyy-mm-dd}/{uuid}.{ext}` for uploads, `raw/url/{sha256}.snapshot` for URL snapshots. Retained.

### Storage lifecycle

Revised from the initial draft:

- `raw/` — retained. Finalized `SourceDocument.rawObjectUri` points here; expiring these would leave dangling references and block reprocessing.
- `normalized/` — retained. Canonical chunk bodies.
- `stage-state/ingestion/` — expire after 7 days. Per-job scratch that FINALIZE no longer needs once the job is terminal.
- `temporary/` (catch-all) — expire after 1 day.
- Multipart uploads under every prefix — abort after 3 days.

**No rule prefix may nest inside another (M2-R2 §3).** S3 applies every lifecycle rule whose prefix matches a key, and the earliest expiration wins. The previous layout put stage state at `temporary/ingestion/` (7 days) under the `temporary/` catch-all (1 day), so stage state actually expired after 1 day. Stage state moved to a separate top-level prefix rather than splitting the catch-all into one rule per known transient prefix, because a catch-all that silently stops covering new scratch prefixes is the worse failure. The CDK test asserts the *effective* TTL for representative keys and that no prefix nests inside another.

M2's private-beta volume is small; storage-cost pressure comes later.

### Parsing

- PDF: deterministic text-layer extraction via [`unpdf`](https://github.com/unjs/unpdf) (Node/serverless-friendly wrapper around `pdfjs-dist`). Real integration tested in `packages/ingestion/src/parsers/unpdf-extractor.test.ts` against a `pdf-lib`-generated fixture; the unit tests inject a stub extractor.
- HTML: `cheerio`, strips scripts/nav/aside/footer, prefers `<main>` / `[role=main]`.
- Fallback: `createStubFallbackParser()` — declared, throws. Concrete OCR/AI implementation deferred until we have real failure data (§16).

### Quality gate

`PARSE` fails the job (not FINALIZE) when the deterministic extractor cannot produce usable text:

- zero blocks emitted;
- `quality.isLikelyScan === true` (heuristic: >50 % empty pages or <40 avg chars per page);
- `> 70 %` of pages emitted no text.

The full quality report is persisted on `IngestionJob.qualityReport` and returned by `GET /ingestion/{jobId}` so an operator can see why. `knowledgeRevision` is untouched — no authoritative state changes on a quality-gate failure.

`CHUNK` fails when the chunker produces zero chunks even though PARSE was happy (very short/degenerate documents).

### Chunking

Heading-aware chunker with configurable min/target/max token budget (defaults 300/500/700 approximate tokens, `chars/4` heuristic). Never merges across headings, sentence-splits oversized single blocks, page ranges = min/max of source blocks.

### Chunk id derivation

`chunkId = ch_<plannedDocumentId suffix>_<zero-padded ordinal>`. Deterministic per `(plannedDocumentId, ordinal)` so re-running `CHUNK` after a partial failure overwrites the same rows in place rather than piling up duplicates.

### Deduplication scope

Scope: `(gameId, editionId, contentId, contentHash)`. `contentId` is part of the identity because the same bytes may legitimately be attached to different content packages (a rulebook PDF that also serves as a promo pack's reference). `sourceType` is NOT part of the identity — the same document should not be re-ingested twice for a single content package just because the operator picked a different `sourceType` on the second attempt. Documented and covered by regression tests in both persistence and pipeline.

### FINALIZE — failure-safe publication

Rewritten from the pre-review draft. The old order mutated authoritative state before the new document was durable; the revised order guarantees "the previous CURRENT document and the edition knowledgeRevision remain unchanged until the replacement document and all required chunk artifacts are durably prepared":

1. `CHUNK` reserves `plannedDocumentId` (if not already set on retry) and **persists it on the job before writing any chunk artifact** (M2-R2 §1), then writes every chunk body to S3 and every chunk metadata row to DynamoDB against that id. Previously the id was persisted only after the writes, so a crash in between made the retry pick a fresh id and orphan the first attempt's chunks. Chunk ids are deterministic, so a retry overwrites. CHUNK also records the parser's `pageCount` on the job (M2-R2 §5); FINALIZE publishes that rather than `max(chunk.pageEnd)`, which undercounts when trailing pages yield no text. Fails if the chunker produced zero chunks.
2. `FINALIZE` first does the dedup lookup by `(game, edition, contentId, contentHash)`.
   - Real duplicate (existing doc that is not our `plannedDocumentId`) → success with `duplicateOf` set. No mutations.
   - Existing doc equals `plannedDocumentId` → defensive recovery (see step 5: a landed transaction normally means the job is already SUCCEEDED and the runner exits before FINALIZE runs). Success without `duplicateOf`.
3. Verifies persisted chunk count matches `job.chunkCount`. Fails FINALIZE if not (a retry of `CHUNK` will re-establish the invariant).
4. Reads current game/edition state, computes the new `SourceDocument` and `nextEditions[]` (bumped `knowledgeRevision`).
5. **Single atomic publish via `AtomicPublisher.publishDocument()`** — DynamoDB `TransactWriteItems` with four actions:
   - `Put` new `SourceDocument` (condition `attribute_not_exists(documentId)`)
   - `Update` previous CURRENT doc to SUPERSEDED (condition `status = CURRENT`)
   - `Update` game row with `nextEditions` (condition `updatedAt = expected`)
   - `Put` the ingestion job in its final `SUCCEEDED` shape (condition `updatedAt = expected`)
   All four land, or none do. FINALIZE performs no separate job write afterwards.

**Why the job write is inside the transaction (M2-R1 §1).** With only three items, a crash or lost response between the commit and the follow-up `updateJob` left the document CURRENT and the revision bumped while the job read `RUNNING` — and if the error surfaced in the runner, `failJob` / `MarkJobFailed` would then record `FAILED` for a job whose document is live. The alternative (tolerate "doc is CURRENT with our `plannedDocumentId`" as a recovery path) only helps if FINALIZE is re-run, which a persisted `FAILED` prevents. Making the job row a fourth transaction item removes the window instead of recovering from it: "document CURRENT" ⇔ "job SUCCEEDED". The SDK's auto-generated `ClientRequestToken` makes the transaction idempotent across SDK-level retries; a Step Functions retry of the task sees `SUCCEEDED` and exits as already-terminal. DynamoDB's 100-item transaction limit is not a concern at four items.

`PublishConflictError` reasons map to typed recovery:

- `DOC_EXISTS` — defensive: the planned document is already present. Recover as success (not duplicate).
- `PREV_NOT_CURRENT` / `GAME_STALE` / `JOB_STALE` — optimistic-concurrency conflicts that a fresh read can resolve. FINALIZE throws `RetryableStageError` (Lambda `errorType` = `RetryableStageError`); the runner does **not** persist `FAILED`, the job stays `RUNNING`, and the FINALIZE task's Retry policy re-runs it. Only after retries are exhausted does the Catch path record `FAILED` via `MarkJobFailed`. (Before M2-R1 these were persisted as `FAILED` by the runner, which made the documented "retry" impossible.)

### Chunk currency

`SourceDocument.status` is the only source of truth for currency. Chunks carry no currency flag: the earlier `Chunk.isCurrent` field was a creation-time snapshot that was always `true` and never updated on supersede, so it was removed (M2-R2 §4) rather than left as a footgun. The retriever (M3) MUST filter by joining chunks to their `SourceDocument` and checking `status = CURRENT`. Chunk rows written before the removal still carry the attribute in DynamoDB; `ChunkSchema` strips unknown keys on read, so they parse without it.

### SSRF guard + redirect handling

`assertUrlSafeForFetch` rejects non-http(s), loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16` + EC2 metadata, `fe80::/10`), multicast, and `.local` / `.internal` hostnames. Resolved IPs are re-checked.

Redirects are handled **manually** (`redirect: 'manual'` on every hop). An initially safe public URL cannot redirect to a private target — every `Location` is validated through `assertUrlSafeForFetch` before the next request. Bounded at 5 redirects. `SourceDocument.canonicalUrl` records the FINAL URL after redirects, not the initial one.

**Residual risk (DNS rebinding):** `assertUrlSafeForFetch` resolves the hostname and re-checks the resolved IPs, but the subsequent `fetch()` performs its own DNS lookup, which could in principle return a different IP. Node's `fetch` (undici) does not currently accept a "pin to this IP" hint. Mitigating fully requires a custom `undici.Agent` with a pinned resolver; tracked as a follow-up. Impact: an adversary controlling DNS for their hostname could theoretically flip the returned IP between validation and connection. Not remediated in M2.

### `POST /ingestion` public schema

Does NOT accept `forceFailureStage`. That field lives on `IngestionJobSchema` for internal test use only; tests construct jobs against `InternalCreateIngestionJobInputSchema` directly. The public schema is `CreateIngestionJobInputSchema`.

### Bucket CORS

Ingestion bucket `AllowedOrigins` is pinned to the CloudFront distribution's `distributionDomainName` in dev (via the L1 CfnBucket escape hatch since the distribution is constructed later). Never `*`. Consistent with ADR-0007 same-origin routing.

### BatchWrite retry

`DynamoChunksRepository.putChunks` and `deleteChunksForDocument` loop over `UnprocessedItems` with capped exponential backoff (up to 6 attempts, 100 ms base with jitter). Throws if items remain after `maxAttempts` — the write must not silently drop chunks or the `SourceDocument.chunkCount` claim would exceed reality.

## Alternatives considered

- **One Lambda per stage.** Rejected. Eight cold starts, more IAM roles, more log groups. No operational benefit at M2 scale.
- **In-process pipeline (no Step Functions).** Rejected. §47 explicitly calls for observable stages; the state machine also gives us the `EMBED` / `INDEX` slot for M3 without a rewrite.
- **Bump `knowledgeRevision` before publish.** Rejected. Violates the "previous knowledge unchanged until new knowledge is durable" invariant.
- **Store full chunk text on DDB row.** Rejected. Chunk bodies can be 500–2000 tokens; DDB row size limit and per-request cost pushed us to keep canonical bodies in S3 with a 400-char preview on the row.
- **Automatic OCR fallback.** Rejected in M2. §16 requires empirical justification.
- **GSI on `contentHash` for dedup lookup.** Rejected at M2 scale. `Scan` with `FilterExpression` scoped to `(gameId, editionId)` is legible; upgrade path is a `${gameId}#${editionId}` GSI once doc counts exceed a few hundred per edition.
- **`redirect: 'follow'` in `fetch()`.** Rejected. Undici follows redirects without re-consulting the SSRF guard. Manual handling is the fix.

## Consequences

- **Positive:**
  - Duplicate short-circuits, quality-gate failures, and FINALIZE crashes all keep authoritative state clean. The invariant is exercised by unit tests in `apps/api/src/ingestion/pipeline.test.ts` (crash-between-CHUNK-and-FINALIZE, crash-after-publish-before-updateJob, forced NORMALIZE failure, SSRF rejection, quality gate).
  - The state machine's `Choice` branches make duplicate/completed jobs skip downstream stages instead of running them for nothing.
  - `MarkJobFailed_<STAGE>` closes the "Lambda infra failure leaves job stuck RUNNING" hole.
  - Real `unpdf` integration is now covered by an automated test against a `pdf-lib` synthetic PDF.
- **Negative:**
  - Two hops per stage: Choice + Task. Adds a few ms per stage; ingestion is background work.
  - `unpdf` pulls `pdfjs-dist`, ~4.6 MB bundle. Under the 250 MB Lambda unzipped limit.
  - `Scan`-based edition scoping — dev-scale only. Upgrade path documented.
  - DNS-rebinding residual risk on URL ingestion — documented, tracked.
- **Follow-up:**
  - M3 wires the actual embedder + vector index and enables the `EMBED` / `INDEX` Lambdas. The Choice state that currently short-circuits duplicates already exits before those stages.
  - Post-merge dev acceptance: ingest at least two structurally different real PDF rulebooks and one real URL through the deployed pipeline; verify superseding + revision increment; inspect chunks. Do not commit copyrighted rulebooks.
  - Custom `undici.Agent` with a pinned DNS resolver to close the DNS-rebinding gap.
  - GSI upgrade for edition-scoped lookups (M6/M7 when the ruling cache / errata discovery expand the write pattern).
