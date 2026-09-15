# ADR-0002: Vector store — Amazon S3 Vectors (initial)

- **Status:** Accepted
- **Date:** 2026-09-15
- **Related:** `MASTER_PLAN.md` §10, §20, §22, §73; Milestone 3, Milestone 7

## Context

The system needs a vector index for rule chunks and, later, for cached ruling questions. The project's cost principle (§2.6) strongly prefers serverless, pay-per-request storage over always-on search clusters. Board-game vocabulary contains exact keyword terms (DEPLOY, Sustain Damage, Ambush…) which may favour hybrid lexical+semantic retrieval — an empirical question, not one to resolve by fiat.

## Decision

- **Initial retriever:** Amazon S3 Vectors, accessed only through a `RulesRetriever` interface defined in `packages/retrieval`.
- **Embedding model:** Amazon Titan Text Embeddings V2, initial dimension **1024**. Dimension is a config value; the retrieval evaluator must be able to compare 1024 vs 512 without code changes.
- **Filtering:** every retrieval call carries `gameId`, `editionId`, `enabledContentIds`, and a version predicate that excludes superseded documents. Filtering happens inside the retriever adapter, not in call sites.
- **No hybrid search initially.** OpenSearch, Kendra, or another hybrid backend is only introduced if the Milestone 7 benchmark demonstrates that pure semantic S3 Vectors retrieval fails the retrieval quality bar (Recall@K, MRR, irrelevant-result rate).

## Alternatives considered

- **Amazon OpenSearch Serverless (vector + BM25 hybrid).** Deferred, not rejected. Higher baseline cost and operational complexity; introduce only if the benchmark demands it.
- **Amazon Kendra.** Rejected initially: cost profile is not proportional to usage; fits enterprise-search shapes, not per-game rule corpora.
- **pgvector on Aurora Serverless / RDS.** Rejected: reintroduces always-on database ops for a workload that has none.

## Consequences

- **Positive:** cost scales to zero when idle; no clusters to size, patch, or scale.
- **Negative:** S3 Vectors is a young service — regional availability, per-request performance, and metadata filter semantics need to be verified during Milestone 0 bootstrap and Milestone 3. If ap-southeast-1 does not offer S3 Vectors at implementation time, retrieval infrastructure may need to live in a different region than the main workload (see `docs/CONTRADICTIONS_AND_GAPS.md`).
- **Negative:** pure semantic retrieval may underperform on exact-keyword rules terms; Milestone 7 is designed to catch this.
- **Follow-up:** the ruling cache (Milestone 6) will also need a semantic index. Same S3 Vectors service, separate logical index — record shape in the Milestone 6 spec or a follow-up ADR.
