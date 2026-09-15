# Milestone 2 — Document Ingestion

**Master plan reference:** §5, §7, §13, §14, §15, §16, §17, §18, §19, §47, §49, §62. **ADRs:** 0001. **Depends on:** M1.

## Objective

Reliably ingest PDF rulebooks, web-based living rules, and other authoritative sources into normalized, chunk-level records with correct source metadata — **without embeddings**. Chunks must be inspectable and demonstrably correct before Milestone 3 puts them into a vector index.

## Deliverables

Upload / ingestion API in `apps/api` (`MASTER_PLAN.md` §46):

- `POST /uploads/presign` — returns an S3 presigned PUT to `raw/` with MIME/size constraints (`MASTER_PLAN.md` §49).
- `POST /ingestion` — accepts either an S3 key from the presign step or a URL; starts an async job.
- `GET /ingestion/{jobId}` — returns job status and stage.

Async orchestration in `infrastructure/cdk` (`MASTER_PLAN.md` §47):

- Step Functions state machine with stages: Validate → Fetch → Parse → Classify → DiscoverErrata → Normalize → Chunk → Finalize.
  - (Embed / Index stages are stubbed in the state machine but skipped — enabled in M3.)
- Each stage is a Lambda; retries with backoff; idempotent; state stored in DynamoDB `IngestionJobs`.
- A partial failure leaves the game marked as it was before the ingestion started (never partially "active").

Parsing in `packages/ingestion`:

- PDF text-layer extractor as the first-choice parser (`MASTER_PLAN.md` §16). Deterministic, no OCR.
- Quality detector: flags empty pages, garbled text, broken reading order, obvious scans.
- Fallback extraction path is stubbed behind an interface; the concrete OCR/AI implementation is deferred to a later milestone or an ADR when we have real failure data.
- Web/living-rules ingestor (`MASTER_PLAN.md` §17): validates URL, blocks internal/private targets (SSRF guard), fetches, strips boilerplate, normalizes text, snapshots original.
- All ingested text tagged with source page/section metadata.

Normalization & chunking (`MASTER_PLAN.md` §15):

- Heading-aware chunker preserving heading path, rule numbers, list relationships, defined terms.
- Target ~300–700 tokens per chunk, configurable.
- Contextual prefix (`Game: … / Content: … / Section: …`) prepared for embedding text (used in M3).

Document & chunk model (`MASTER_PLAN.md` §13, §14):

- `SourceDocument` and `Chunk` records persisted (documents in DynamoDB, chunk text in S3 `normalized/`, chunk metadata in DynamoDB).
- `contentHash` computed; duplicate uploads short-circuit and do not create new documents (`MASTER_PLAN.md` §18).
- New version detection: mark previous document `superseded`, new `current`, bump the game's `knowledgeRevision` counter (`MASTER_PLAN.md` §19).

Frontend:

- Add-Game workflow can now upload a PDF or paste a URL and see ingestion progress driven by `GET /ingestion/{jobId}`.
- Job status UI is polling-based; no need for WebSockets in this milestone.

## Explicitly out of scope

- Embeddings and vector storage (M3).
- Automatic errata/FAQ discovery on the web (M6).
- Any answer generation.
- OCR / AI-based document parsing (deferred; introduce with data).

## Verification

1. Upload two structurally different rulebook PDFs to dev: chunks are produced with correct heading paths and page ranges. Manual spot-check via a small `GET /sources/{sourceId}` endpoint (per §46) or admin script.
2. Ingest a living-rules URL: same result via the web path.
3. Re-upload the same PDF: no duplicate document, `knowledgeRevision` unchanged.
4. Upload a modified version of the same rulebook: previous document marked `superseded`, new document `current`, `knowledgeRevision` incremented.
5. SSRF attempt against a private-IP URL is rejected before fetch.
6. A forced-failure at the Normalize stage leaves the job in a failed state and the game unchanged.

## Definition of Done

`MASTER_PLAN.md` §71. No evaluation cases required yet (retrieval eval arrives in M3), but include ingestion-level fixtures under `evals/fixtures/ingestion/` for at least one rulebook.
