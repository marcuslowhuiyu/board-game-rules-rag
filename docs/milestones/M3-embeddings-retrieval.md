# Milestone 3 — Embeddings, Retrieval & Evaluation Foundation

**Master plan reference:** §20, §21, §22, §34–§37, §43, §63. **ADRs:** 0002. **Depends on:** M2.

## Objective

Turn ingested chunks into a searchable, filter-aware retriever, and establish the retrieval evaluation framework that future milestones extend. Answer generation is **not** part of this milestone.

## Deliverables

Embeddings in `packages/ai`:

- `EmbeddingsProvider` interface; Titan Text Embeddings V2 adapter as the initial implementation.
- Dimension is configurable (initial 1024). Adapter accepts arbitrary batch sizes; batching implemented for cost.

Retrieval in `packages/retrieval`:

- `RulesRetriever` interface (`MASTER_PLAN.md` §20).
- `S3VectorsRetriever` implementation.
- Every `retrieve(query)` call **requires** `gameId`, `editionId`, `enabledContentIds`. The adapter enforces metadata filtering; a call without these is a compile-time or immediate runtime error.
- Supersession filter excludes non-`current` documents by default.
- Returns 10–15 candidate chunks; a separate ranker/reducer trims to 4–8 (initial reducer can be identity or MMR; note the choice in the impl).

Ingestion wiring:

- The Step Functions state machine's Embed and Index stages, stubbed in M2, are enabled here. Chunks embed on ingestion, stored in S3 Vectors, and marked ready.

Retrieval API surface:

- Internal only. Do not expose retrieval directly to the frontend in this milestone.

Evaluation framework in `evals/`:

- Dataset format documented (JSONL, one row per case) matching `MASTER_PLAN.md` §36 conceptually but scoped to retrieval only: `id`, `game`, `edition`, `enabledContent`, `question`, `requiredEvidence` (chunk id or a stable rule key).
- Initial ~30–50 retrieval cases across **at least 3 structurally different games** (e.g. dense-rules card game, campaign board game, dungeon crawler with rule references).
- `evals/run-retrieval-eval.ts` runs the dataset and reports Recall@1, Recall@3, Recall@5, MRR, and irrelevant-result rate.
- Report is a JSON artifact in `evals/reports/` (gitignored); a small `--markdown` mode prints a table for PR discussion.

CI:

- Retrieval regression subset (fast, deterministic cases) runs on PRs that touch `packages/retrieval`, `packages/ai`, or `packages/ingestion`.
- Full retrieval eval runs on demand (`workflow_dispatch` or locally). The nightly schedule was dropped on 2026-10-26 to stay within the CI-minutes budget (ADR-0009).

## Explicitly out of scope

- Rules answering. Retrieval is judged on its own.
- Hybrid search / OpenSearch. Only revisit if this milestone's metrics fall below the quality bar we set here.
- LLM-as-judge (that arrives in M7).

## Verification

1. Ingesting a rulebook produces embedded chunks in S3 Vectors, discoverable by a direct retriever call.
2. Property-style test: retrieval for a session with a promo **disabled** never returns a chunk from that promo's document.
3. Property test: retrieval for an old edition never returns chunks from the newer, superseded edition (and vice versa).
4. Full retrieval eval runs green (on demand) and produces a report with all five metrics for each game.
5. Baseline metrics recorded in `CURRENT_STATE.md` for future comparisons.

## Definition of Done

`MASTER_PLAN.md` §71. Includes "relevant evaluation cases added" — the initial retrieval golden set.
