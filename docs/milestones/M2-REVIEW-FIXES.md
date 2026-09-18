# M2 — Remaining Review Fixes (Handoff)

**Status:** open review work on PR #7. **PR #7 must not be merged yet.** **Do not begin Milestone 3.**

The initial M2 PR received two rounds of review; the second round surfaced a further set of issues that outgrew a single working session. This document captures only the remaining work, divided into three ordered slices.

**Rules for whoever picks this up:**

- Complete and commit each slice **separately** (one commit per slice, on `feature/m02-document-ingestion`).
- **Stop for human review after each slice** before starting the next.
- After all three slices are merged into the branch, a **final PR review** is required before PR #7 can merge.
- Even after PR #7 merges, **M2 is not closed** — the post-merge real-document acceptance in dev (two structurally different real rulebook PDFs + one real URL ingestion + version supersede + `knowledgeRevision` increment) still has to run before M2 is declared done and M3 may begin.
- Keep the architectural choices already established: single stage-runner Lambda, `unpdf` as PDF extractor, OCR/AI fallback deferred, embeddings deferred to M3. Any deviation requires a new ADR.

---

## M2-R1 — Pipeline state correctness

1. **Close the FINALIZE publish/job-status consistency gap.** Today the atomic publish (`AtomicPublisher.publishDocument`) commits its three-item DDB transaction; the immediately-following `IngestionJobsRepository.updateJob` write is *not* part of that transaction. A crash in between leaves the document CURRENT and the edition `knowledgeRevision` bumped but the job row still `RUNNING`/`FINALIZE`. The retry-recovery path via `PublishConflictError.DOC_EXISTS` covers one crash location but not this one. Options: include the job update inside the transaction (four items instead of three), or make FINALIZE tolerate observing "doc is CURRENT with our `plannedDocumentId`" as an explicit recovery-into-success path even when the transaction didn't cancel. Pick one, document the choice.
2. **Fix GAME_STALE / PREV_NOT_CURRENT retry semantics.** `PublishConflictError` for these two reasons is currently rethrown as `StageError` from FINALIZE, which the runner promotes to a persisted `FAILED` job. That is wrong for these two conflict types — they are recoverable-by-retry, not terminal. Change the runner (or FINALIZE) so those two `PublishConflictError` reasons do NOT call `failJob`; instead they let Step Functions retry the FINALIZE task, which will re-read `game.updatedAt` and the previous CURRENT doc. Add a retry policy on the FINALIZE task in the state machine that specifically retries these coded errors a bounded number of times.
3. **Make terminal routing distinguish SUCCEEDED from FAILED.** The `Choice_After_<STAGE>` state currently only branches on `$.terminal === true` and sends every terminal result to `SkipEmbedIndexInM2 → PipelineSucceeded`. A FAILED job that somehow arrives at that Choice (e.g. redelivery of a stage against an already-terminal FAILED job) would be routed to Succeed. Split the Choice: `terminal === true && status === 'SUCCEEDED'` → success path; `terminal === true && status === 'FAILED'` → route through `MarkJobFailed_<STAGE>` (idempotent — already checks for existing FAILED status) → `PipelineFailed`. Add a unit + CDK test for both branches.
4. **Ensure `MarkJobFailed` never overwrites an already-SUCCEEDED job.** The current implementation checks for `status === 'FAILED'` and skips, but does NOT check for `status === 'SUCCEEDED'`. If the state machine's Catch fires against a job that the stage runner already marked SUCCEEDED (racy with the runner writing SUCCEEDED and Step Functions timing out the invocation), `MarkJobFailed` would silently downgrade the job to FAILED. Add the `SUCCEEDED` guard, log the skip, and cover it with a test.

---

## M2-R2 — Chunk idempotency and storage invariants

1. **Persist/reserve `plannedDocumentId` before chunk artifact writes.** `stageChunk` currently reserves `plannedDocumentId` locally, writes chunk bodies to S3, writes chunk metadata to DDB, and *then* persists the reserved id back to the job row via `advanceStage`. If the process crashes after S3/DDB writes but before the job update, a retry will pick a *fresh* `plannedDocumentId` — the previous run's chunks become orphaned in `normalized/{old-doc-id}/...` and the count check in FINALIZE won't match. Persist `plannedDocumentId` on the job *first* (write-then-write pattern), so the first thing a retry does is see and reuse it.
2. **Add CHUNK crash/retry coverage.** Extend `apps/api/src/ingestion/pipeline.test.ts`: (a) crash between "reserve `plannedDocumentId` and persist it" and any chunk write — retry uses the same id, no orphans; (b) crash between chunk-body S3 puts and the DDB `putChunks` — retry re-runs the whole CHUNK safely because both writes are keyed by deterministic chunk id; (c) partial DDB `putChunks` batch failure that triggers the R6 retry loop — chunk count still matches at FINALIZE.
3. **Fix overlapping S3 lifecycle expiration rules.** `expire-temporary-ingestion-7d` (prefix `temporary/ingestion/`, 7d) and `expire-temporary-1d` (prefix `temporary/`, 1d) both apply to any object under `temporary/ingestion/…` because S3 lifecycle rules match by *prefix*, and both rules match. The 1d rule wins because it's more aggressive, so stage state actually expires after 1d, not 7d. Restructure so the 1d catch-all does not also apply to `temporary/ingestion/`. Options: move stage state to a different top-level prefix (e.g. `stage-state/ingestion/`), or make the catch-all more specific (e.g. one rule per known transient prefix). Update the CDK test to actually assert the intended per-prefix TTL, and update ADR-0008.
4. **Remove `Chunk.isCurrent`.** ADR-0008 already establishes `SourceDocument.status` as the authoritative currency source and `Chunk.isCurrent` as "a creation-time snapshot", but the field is still on the schema and always written as `true`. Drop the field entirely from `ChunkSchema` and from the FINALIZE writer. If any downstream code (M3 retriever plans) was going to consult it, redirect it to join on `SourceDocument.status` instead. Fewer footguns for M3.
5. **Preserve the actual parsed `pageCount` in `SourceDocument`.** FINALIZE currently computes `pageCount = max(chunk.pageEnd)`. That understates the true page count when the last page produced no chunks (empty page, back-cover, whitespace-only). The correct value is `ParsedDocument.pageCount` from the parser — persist it in the CHUNK stage's state or on the job so FINALIZE can use it directly.

---

## M2-R3 — Parse quality and final cleanup

1. **Add a garbled-text rejection threshold.** `analyzeQuality` computes `garbledCharRatio` and surfaces it in `warnings`, but the PARSE stage does not currently fail on it — only `isLikelyScan`, zero blocks, and `emptyPageRatio > 0.7` trigger `EMPTY_PARSE`/`LIKELY_SCAN`/`HIGH_EMPTY_PAGE_RATIO`. A high garbled ratio (broken text-layer extraction that yields lots of replacement characters) can slip through and become CURRENT. Add a threshold (start at `> 0.05`, tune after real-PDF acceptance) that fails the PARSE stage with `GARBLED_EXTRACTION`. Regression test with an extractor that returns a page of `�` characters.
2. **Keep PDF scan-specific quality checks separate from HTML quality validation.** `analyzeQuality` runs against both PDFs and HTML pages via `createHtmlParser` → `analyzeQuality({ pageCount: 1, pageTexts: [combined] })`. The `isLikelyScan` heuristic (`>50% empty pages OR <40 avg chars per page`) is meaningless for HTML — a very short living-rules page could trip it. Split the quality-report application in the pipeline: PDF ingestion runs the full quality gate (scan + empty pages + garbled); HTML ingestion runs a narrower gate (zero blocks, garbled). Route on the parser choice (`pickParser`) or on `fetchState.contentType`. Regression tests for both paths.
3. **Add regression tests.** Beyond the item-specific tests called out above, add explicit tests for: (a) M2-R1 §3 both Choice branches; (b) M2-R2 §5 `pageCount` preservation when the last page is empty; (c) M2-R3 §2 an HTML page that would trip `isLikelyScan` under PDF rules but passes under HTML rules.
4. **Update `ADR-0008` and `CURRENT_STATE.md` if any decision changed.** In particular the transaction scope for M2-R1 §1, the storage-lifecycle restructure for M2-R2 §3, the `Chunk.isCurrent` removal for M2-R2 §4, and the split quality gate for M2-R3 §2 all warrant a paragraph in ADR-0008. Update `CURRENT_STATE.md` known-issues and Milestone-2-what-landed sections to reflect the state of the branch. Update the PR #7 description and test counts.
5. **Run the complete M2 quality gates.** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm synth`, then verify PR #7 CI is green. Do not merge.

---

## Reference

- PR #7: https://github.com/marcuslowhuiyu/board-game-rules-rag/pull/7
- ADR-0008 (revised in the second review): `docs/adr/0008-document-ingestion-pipeline.md`
- Milestone spec: `docs/milestones/M2-document-ingestion.md`
- Current state: `CURRENT_STATE.md`
