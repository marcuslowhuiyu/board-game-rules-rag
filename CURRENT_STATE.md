# Current State

_Last updated: 2026-09-17_

## Current milestone

**Milestone 2 — Document Ingestion** (feature branch `feature/m02-document-ingestion`; PR open; awaiting review + merge + dev deploy).

Spec: `docs/milestones/M2-document-ingestion.md`.
Architecture decision: `docs/adr/0008-document-ingestion-pipeline.md`.

## Completed work

- **Milestone 0 — Repository & Engineering Foundation.** Merged. See prior state.
- **Milestone 1 — Domain Model, Game Catalog & Sessions.** Merged as PR #6 / commit `6b50738`. Deployed dev remained green; every M1 acceptance check passed.

## Milestone 2 — what landed on the feature branch

`packages/domain`:

- New schemas: `Chunk`, `IngestionJob` (+ `IngestionJobView`, `CreateIngestionJobInput`), `CreatePresignedUploadInput`. New id types: `ChunkId`, `IngestionJobId`.
- `SourceDocument` promoted from "metadata only" to the full M2 shape: required `contentHash`, `rawObjectUri`, `origin` (`UPLOAD` | `URL`), `chunkCount`, `knowledgeRevision`, `pageCount?`. Status enum tightened to `CURRENT | SUPERSEDED | ARCHIVED` (`SourceDocumentMetadataSchema` remains as a compatibility alias).
- `Edition` grew a required `knowledgeRevision: number` field (default 0) — bumped by the FINALIZE stage per §19.

`packages/persistence`:

- New repositories with in-memory + DynamoDB implementations: `DocumentsRepository`, `ChunksRepository`, `IngestionJobsRepository`.
- `GamesRepository.bumpKnowledgeRevision(gameId, editionId, updatedAt): Promise<number>` — atomic conditional update on `updatedAt` for optimistic concurrency.
- `IdGenerator` gained `sourceDocumentId()`, `chunkId()`, `ingestionJobId()`.

`packages/ingestion` (new fleshed-out package):

- Types: `ParsedBlock`, `ParsedDocument`, `DocumentQualityReport`, `ChunkOutput`.
- Utilities: `sha256Hex`, `approxTokenCount`, `contextualPrefix`, `analyzeQuality`.
- Chunker: `chunkDocument` — heading-aware, configurable 300/500/700-token budget, sentence-split for oversized blocks, page range = min/max of the source blocks.
- Classifier: `classifySource` — downgrades OFFICIAL_RULES to COMMUNITY_DISCUSSION when the canonical URL is a community host.
- Parsers behind `DocumentParser`: `createPdfTextLayerParser(extractor)` (heading heuristic covers ALL-CAPS titles + numeric `1.`, `1.2`, `1.2.3` headings), `createHtmlParser()` (strips scripts/nav, prefers `<main>` / `[role=main]`), `createStubFallbackParser()` (declared, throws — M2 explicitly defers OCR/AI fallback per §16).
- `createUnpdfExtractor()` — real PDF text-layer extraction via `unpdf` (pdfjs-dist wrapper), imported dynamically so the base parser can be unit-tested without pdfjs.
- SSRF guard: `assertUrlSafeForFetch` blocks non-http(s), loopback, private, link-local, EC2 metadata (`169.254.169.254`), multicast, and `.local` / `.internal` hostnames; re-checks resolved IPs (injectable resolver for tests).
- Fetchers: `createUrlFetcher()` (SSRF-guarded, 20 s timeout, 25 MiB response cap), `createS3Fetcher(store)`.
- Object store seam: `ObjectStore` interface + `InMemoryObjectStore` (for tests) + `S3ObjectStore` (in `apps/api/src/lib/`).

`apps/api`:

- New routes: `POST /uploads/presign`, `POST /ingestion`, `GET /ingestion/{jobId}`, `GET /sources/{sourceId}`, `GET /sources/{sourceId}/chunks`.
- Presign: MIME-restricted (`application/pdf`, `text/html`, `application/xhtml+xml`), size-capped (env `UPLOAD_MAX_BYTES`, default 50 MiB), 10-minute expiry, S3 key `raw/{yyyy-mm-dd}/{uuid}.{ext}`.
- `POST /ingestion` validates the game/edition/content triple, sanity-checks S3-key existence for `S3` sources, creates a `PENDING` job, and calls `IngestionExecutor.start(jobId)` — which in production issues `StartExecution` against the M2 state machine.
- `apps/api/src/ingestion/pipeline.ts` implements every stage as a pure function of `(job, StageContext)`; `runFullPipeline(jobId, ctx)` runs the whole chain in-process (used by unit tests + optional dev fixture scripts).
- `apps/api/src/ingestion/stage-runner.ts` is the Lambda handler each Step Function Task invokes with `{ jobId, stage }`.
- Dev-only `forceFailureStage` field on jobs — the pipeline throws at the requested stage. Used by the "forced Normalize failure leaves game unchanged" acceptance test (spec verification #6).

`infrastructure/cdk`:

- Three new DynamoDB tables: `documents` (PK `documentId`), `chunks` (PK `documentId`, SK `chunkId`), `ingestionJobs` (PK `jobId`) — all on-demand with SSE + PITR.
- `IngestionBucket` — private S3 with SSL enforced, PUT-only CORS (`AllowedOrigins: *` for dev — tightening deferred to public beta), and lifecycle rules: `raw/` expires after 90 days, `temporary/` after 1 day, multipart uploads under `normalized/` aborted after 3 days.
- `IngestionStageRunnerFn` — Node 22, 1024 MB, 60 s timeout, its own log group.
- `IngestionStateMachine` — Standard workflow, 15 min timeout. Chain: `Stage_VALIDATE → Stage_FETCH → Stage_PARSE → Stage_CLASSIFY → Stage_DISCOVER_ERRATA → Stage_NORMALIZE → Stage_CHUNK → Stage_FINALIZE → SkipEmbedIndexInM2 → PipelineSucceeded`. Each Task retries transient Lambda errors twice and catches everything else to `PipelineFailed`.
- API Lambda gets read access to `documents`/`chunks`, read/write on `ingestionJobs`, read/write on the ingestion bucket, and `states:StartExecution` on the state machine; the stage runner gets read on `content`, read/write on the other five tables and the bucket. `INGESTION_STATE_MACHINE_ARN` is injected into the API Lambda env.
- CDK unit test coverage extended to seven DDB tables, the ingestion bucket lifecycle + CORS, the state machine's Task chain, and the new HTTP API routes.

`apps/web`:

- New `SourcesScreen`: content picker, source-type dropdown, PDF upload (presign → PUT → `POST /ingestion`) or URL paste, polling `GET /ingestion/{jobId}` every 2 s until terminal, showing status, stage progression, and `duplicateOf` / `chunkCount` / error details.
- `GameConfigurationScreen` gained a "Manage sources" button that navigates to the new screen.
- API client extended with `presignUpload`, `uploadFile`, `createIngestion`, `getIngestion`; new type surface (`IngestionJobView`, `PresignedUploadResponse`, `SourceType`, `Authority`, …).

`evals/fixtures/ingestion/`:

- `tiny-rulebook.pages.json` — per-page plaintext for the two-page synthetic rulebook.
- `tiny-rulebook.v2.pages.json` — same rulebook with an errata section, used to exercise the supersede/`knowledgeRevision` flow.
- `living-rules.html` — small living-rules page used by the HTML parser test and by the future URL smoke test.
- `README.md` explains why no real PDF ships in git (extractor seam lets us test parser/chunker with plaintext fixtures).

## Active decisions

Load-bearing decisions from `docs/adr/`:

- **ADR-0001** — TypeScript strict, Node 22 LTS, pnpm 10, CDK v2 TypeScript. Vitest / ESLint 9 / Prettier 3.
- **ADR-0002** — S3 Vectors initial vector store behind `RulesRetriever`.
- **ADR-0003** — `RulesModel` interface + Bedrock Converse adapter default.
- **ADR-0004** — DynamoDB full log + rolling summary + recent turns, 24h TTL.
- **ADR-0005** — Bounded `WebSearchProvider` loop with AgentCore adapter.
- **ADR-0006** — DynamoDB multi-table design for M1 entities (games, content, sessions, messages).
- **ADR-0007** — Same-origin routing via CloudFront `/api/*` + first-party `SameSite=Lax` session cookie; no API-side CORS.
- **ADR-0008** — Document ingestion via Step Functions + S3 + DynamoDB; deterministic PDF text-layer first; content-hash dedup + supersede/`knowledgeRevision`; SSRF-guarded URL fetch; injectable seams for parser/fetcher/object-store so the pipeline is exercisable end-to-end without AWS.

## Known issues / open questions

Full tracker: `docs/CONTRADICTIONS_AND_GAPS.md`.

- **G3 / G4 (S3 Vectors and AgentCore regional availability in `ap-southeast-1`).** Still unverified. Not blocking M2. Verify before M3 / M6.
- **Ingestion bucket CORS is wide-open in dev.** `POST /uploads/presign` returns URLs that any origin can PUT to. Fine for the private dev environment; tighten to the CloudFront domain before public beta.
- **No GSI on the documents table.** Edition-scoped lookups (`findByContentHash`, `findCurrentByKey`, `listDocumentsForEdition`) use `Scan` + `FilterExpression` for M2 (documented in ADR-0008). Upgrade path is a `${gameId}#${editionId}` GSI once the doc count grows.
- **Fallback parser is a stub.** `createStubFallbackParser` throws; the quality detector only surfaces warnings. Concrete OCR/AI fallback is deferred to a later milestone or ADR once we have real failure data (per §16 and the milestone spec).
- **`InMemorySessionsRepository`'s TTL check uses wall-clock time.** Tests that hard-code a NOW earlier than the real current date will incorrectly see sessions as expired; fixed by using a far-future NOW in `apps/api/src/handlers/sessions.test.ts`. Pre-existing behavior, worth revisiting when we clock-inject the in-memory repos.
- **CodeQL check is red on PRs.** Same underlying repo-visibility gap as branch protection.

## Requires operator decision, if you want them

- **Branch protection on `main`.** Same options as previously recorded (upgrade to GitHub Pro or make the repo public).
- **AWS_REGION for a possible second region** for S3 Vectors or AgentCore — pending G3 / G4 verification.

## Next expected work

Milestone 3 — Embeddings, Retrieval & Evaluation Foundation. See `docs/milestones/M3-embeddings-retrieval.md`.
