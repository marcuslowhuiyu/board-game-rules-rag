# Milestone 7 — Model & Retrieval Benchmarking

**Master plan reference:** §22, §34–§42, §67, §73. **ADRs:** 0002, 0003. **Depends on:** M6.

## Objective

Make the load-bearing quality/cost trade-offs on evidence, not on intuition. This milestone builds the comparative benchmarking harness, runs it against the current baseline, and records the outcomes in ADRs — potentially replacing the initial model or vector-store choice.

## Deliverables

Dataset expansion:

- Grow the golden dataset to ~150–200 cases across the categories in `MASTER_PLAN.md` §35 and at least the same three-plus games used in earlier milestones.
- Add human-reviewed reference rulings for a designated "gold subset" (`MASTER_PLAN.md` §40) — these anchor judge scoring.

Comparative model runner in `evals/`:

- `compare-models.ts` runs a fixed set of `(question, evidence, system prompt, schema)` inputs across multiple candidate models. Only the model changes.
- Metrics recorded per model (`MASTER_PLAN.md` §38): correctness, citation faithfulness, hallucination rate, uncertainty calibration, authority adherence, expansion/promo correctness, latency, input/output tokens, estimated cost.

LLM-as-judge:

- Bedrock model evaluation with custom judge criteria (`MASTER_PLAN.md` §39): `RulingCorrectness`, `EvidenceGrounding`, `CitationFaithfulness`, `AuthorityCompliance`, `UncertaintyCalibration`, `ConfigurationCompliance`.
- Judge model configured via `models.judge` — must not be the same model as the candidate under test.
- Judge results combined with deterministic assertions and human reference rulings; never used alone (`MASTER_PLAN.md` §40).

Retrieval and embedding experiments:

- `1024 vs 512` embedding dimension comparison (same retrieval golden set).
- Chunk size alternatives (e.g. 400 vs 700 target tokens).
- Retrieval top-K sweep.
- Optional reranker plug-in evaluated via `RulesRetriever` decorator; introduced only if the numbers justify the added cost/latency.
- Hybrid retrieval spike (`MASTER_PLAN.md` §22) run **only** if pure semantic S3 Vectors falls short.

Report generation:

- `evals/reports/` produces a single-page comparative report per run: quality metrics, hallucination rate, citation faithfulness, uncertainty behaviour, latency, tokens, estimated cost.
- Reports are CI artifacts, not committed (`MASTER_PLAN.md` §43).

Decisions:

- Any outcome that changes production model, embedding size, retriever, or reranker is recorded as a new or amended ADR (`MASTER_PLAN.md` §41). Config values updated; no application rewrite required.

## Explicitly out of scope

- Automatic prod-runtime model routing based on live confidence (cheap→strong fallback). Deferred pending evidence (`MASTER_PLAN.md` §32).
- Public rollout mechanics.

## Verification

1. Full comparative report generated for at least two credible model candidates against the current baseline.
2. Retrieval-side report shows the 1024-vs-512 comparison with the recommended dimension.
3. If a change is made (model, dimension, chunker), an ADR is added or amended and `CURRENT_STATE.md` reflects the new baseline.
4. The judge harness runs headless and produces reproducible scores for the gold subset within a documented variance range.

## Definition of Done

`MASTER_PLAN.md` §71. Includes new eval cases, benchmark reports as artifacts, and any resulting ADR updates.
