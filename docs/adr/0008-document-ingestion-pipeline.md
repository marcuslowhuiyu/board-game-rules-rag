# ADR-0008: Document ingestion — Step Functions + S3 + DynamoDB, deterministic PDF first

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Marcus Low, Claude Code (M2)
- **Related:** `MASTER_PLAN.md` §13, §14, §15, §16, §17, §18, §19, §46, §47, §48, §49; Milestone 2; ADR-0001

## Context

Milestone 2 introduces the first content path into the system: rulebook PDFs and living-rules web pages get parsed, chunked, and stored with source/page/section provenance — but explicitly *without* embeddings or vector storage (those arrive in M3). The pipeline must be idempotent, deduplicated on content hash, and safe against SSRF for URL-based ingestion. §47 calls for observable stages and retryable jobs; §16 calls for a tiered parsing strategy that starts deterministic and only escalates when quality is measurably inadequate.

M1 already established the domain types (`SourceDocumentMetadata`), DynamoDB access, and same-origin CloudFront routing. M2's shape is therefore mostly additive.

## Decision

- **Orchestration:** AWS Step Functions Standard workflow. Each of the eight M2 stages (`VALIDATE`, `FETCH`, `PARSE`, `CLASSIFY`, `DISCOVER_ERRATA`, `NORMALIZE`, `CHUNK`, `FINALIZE`) is a `LambdaInvoke` Task calling **the same** Node 22 Lambda (`ingestion-stage-runner`) with `{ jobId, stage }`. Each Task carries a small retry policy for transient Lambda/SDK errors and a global `Catch` that routes to a single `Fail` state. `EMBED` / `INDEX` are declared in the state machine (a trailing `Pass` state), skipped in M2, and light up in M3.
- **State:** Job state lives in a dedicated `IngestionJobs` DynamoDB table (partition key `jobId`); intermediate stage artifacts (fetched bytes, parsed doc, normalized doc, chunk outputs) live in an S3 bucket at `normalized/{jobId}/state/*.json`. Each stage reads the artifacts it needs by convention and writes its output. This keeps the state machine input tiny (`{ jobId }`) and makes stages resumable/idempotent.
- **Storage layout:**
  - `raw/` — original uploads (from presigned PUT) and URL snapshots (`raw/url/{sha256}.snapshot`).
  - `normalized/{documentId}/{chunkId}.txt` — canonical chunk bodies (source of truth).
  - `normalized/{jobId}/state/*.json` — per-stage intermediate state.
  - `temporary/` — reserved for future short-lived scratch (lifecycle: 1d).
- **Parsing:** PDF text-layer via [`unpdf`](https://github.com/unjs/unpdf) (a Node/serverless-friendly wrapper around `pdfjs-dist`). HTML via `cheerio`, stripping scripts/nav and honouring `<main>` / `[role=main]`. A quality detector (`analyzeQuality`) reports empty-page ratio, average chars/page, and garbled-character ratio; a scan-like report is surfaced to the operator without automatic OCR fallback.
- **Fallback parser:** interface declared, concrete implementation deferred until we have real failure data (§16). The `createStubFallbackParser` throws — the pipeline never routes to it in M2.
- **SSRF guard:** every URL fetch passes through `assertUrlSafeForFetch` — allowed protocols are `http`/`https`; loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`, EC2 metadata `169.254.169.254`), multicast, and `.local`/`.internal` suffixes are all rejected before DNS. Resolved IPs are re-checked.
- **Chunking:** heading-aware chunker (`chunkDocument`) with configurable min/target/max token budget (defaults 300/500/700 approximate tokens, `chars/4` heuristic). Never merges across a heading boundary; sentence-splits oversized single blocks. Preserves min-of-page-starts and max-of-page-ends across the source blocks that form a chunk. Chunks store both an S3 URI (canonical text) and a short `textPreview` on the DDB row so the entire chunk set is inspectable via `GET /sources/{sourceId}/chunks` without an S3 round-trip.
- **Dedup + versioning (§18/§19):** SHA-256 of the raw bytes is the dedup key, scoped to `(gameId, editionId)`. On duplicate: return the existing document, do not create chunks, do not bump `knowledgeRevision`. On a new version of the same `(contentId, sourceType)`: mark the previous `CURRENT` document `SUPERSEDED`, insert the new document `CURRENT` with `supersedes` populated, and bump the edition's `knowledgeRevision`.
- **API surface:** `POST /uploads/presign`, `POST /ingestion`, `GET /ingestion/{jobId}`, `GET /sources/{sourceId}`, `GET /sources/{sourceId}/chunks`. All state-changing endpoints validate input with Zod; presign restricts to `application/pdf` + `text/html` + `application/xhtml+xml`, caps request size at 50 MiB, and returns a short-lived PUT (default 10 minutes).
- **Dependency inversion:** the ingestion package (`@bgr/ingestion`) exposes `DocumentParser`, `DocumentFetcher`, and `ObjectStore` seams. AWS-flavoured implementations (`S3ObjectStore`, `createS3Fetcher(store)`, `createUrlFetcher()`, `createUnpdfExtractor()`, `createHtmlParser()`) are composed only in the Lambda cold path (`apps/api/src/ingestion/stage-context.ts`) — the pipeline stages themselves are testable against `InMemoryObjectStore` and hand-rolled parsers.

## Alternatives considered

- **One Lambda per stage.** Rejected. Eight cold starts per ingestion, more IAM roles to grant, more log groups to alarm; no operational benefit at M2 scale. Same code, one Lambda, distinguished by an `stage` argument is simpler.
- **In-process pipeline (no Step Functions).** Rejected. `§47` explicitly calls for observable stages. Step Functions gives us the execution-history log, per-stage retry semantics, and a clear place to insert `EMBED`/`INDEX` in M3 without touching the API path.
- **Store full chunk text on the DDB row.** Rejected. Chunk bodies can be 500–2000 tokens (~2–8 KiB each) and a rulebook has hundreds of chunks; the DDB row size limit (400 KB) and per-request cost pushed us to keep the canonical body in S3 with a preview on the row.
- **Automatic OCR fallback on the first low-quality parse.** Rejected in M2. §16 requires empirical justification for the additional cost/latency; we surface the quality report and defer the fallback implementation.
- **DynamoDB GSI on `contentHash` for dedup lookup.** Rejected for M2. Dev-scale document counts are small; `Scan` with a `FilterExpression` scoped to `(gameId, editionId)` is legible and cheap. Upgrade path noted: add a GSI keyed by `${gameId}#${editionId}` when document counts per edition exceed a few hundred.

## Consequences

- **Positive:**
  - The pipeline runs end-to-end in-process during tests via `runFullPipeline(jobId, ctx)`, so every acceptance criterion in the milestone spec has a unit-level assertion (see `apps/api/src/ingestion/pipeline.test.ts`).
  - `EMBED` / `INDEX` are already positioned in the state machine — M3 adds two more Task states and Lambda handlers without a redesign.
  - `SourceDocument` and `Chunk` schemas carry every field the retriever will filter on in M3 (`gameId`, `editionId`, `contentId`, `isCurrent`, `authority`, `sourceType`, `documentVersion`).
- **Negative:**
  - Two hops between the API Lambda and the actual work: `POST /ingestion` → `StartExecution` → Task → Lambda. That adds ~50 ms of orchestration latency per ingestion; ingestion is background work, so this is acceptable.
  - `unpdf` pulls in `pdfjs-dist`, growing the stage-runner Lambda's bundle to ~4.6 MB. Still under the 250 MB unzipped Lambda limit and does not affect the API Lambda.
  - `Scan`-based edition scoping means dev-scale performance only. Documented above; upgrade path is a GSI.
- **Follow-up:**
  - M3 wires the actual embedder + vector index and enables the `EMBED` / `INDEX` Lambdas.
  - When production traffic is measurable, revisit the retry counts + Lambda memory (currently 1024 MB, 60 s timeout for the stage runner).
  - The GSI upgrade for edition-scoped lookups should be revisited in M6/M7 when the ruling cache and errata discovery expand the write pattern.
  - `POST /uploads/presign` currently allows PUTs from any origin (`AllowedOrigins: ['*']`) to keep dev flexible. Tighten to the CloudFront domain before public beta.
