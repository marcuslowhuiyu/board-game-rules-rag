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
- **Negative:** S3 Vectors is a young service — regional availability, per-request performance, and metadata filter semantics need to be verified during Milestone 0 bootstrap and Milestone 3. If ap-southeast-1 does not offer S3 Vectors at implementation time, retrieval infrastructure may need to live in a different region than the main workload (see `planning/CONTRADICTIONS_AND_GAPS.md`).
- **Negative:** pure semantic retrieval may underperform on exact-keyword rules terms; Milestone 7 is designed to catch this.
- **Follow-up:** the ruling cache (Milestone 6) will also need a semantic index. Same S3 Vectors service, separate logical index — record shape in the Milestone 6 spec or a follow-up ADR.

## Revisions

### 2026-10-26 — Regions verified (closes G3)

- **S3 Vectors:** available in `ap-southeast-1`. The vector index stays in the main workload region.
- **Embedding model:** Titan Text Embeddings V2 is not offered in `ap-southeast-1`. It is called on demand in **`ap-southeast-2` (Sydney)**. Only the text to embed and the vector cross regions, so the extra transfer cost is negligible (about $0.02 per 10,000 queries); each query takes roughly 100 ms longer.
- **Why Titan V2 over the in-region alternatives:** it is the cheapest per token. Titan V2 costs about $0.026 per 1M input tokens. Cohere Embed v3 costs $0.10 and v4 $0.12 per 1M (v4 runs in Singapore only through a global inference profile). Titan V2 also accepts 8,192 input tokens, against Cohere v3's 512, so the chunk sizes tuned in M2-T1 still fit. It also supports both 1024 and 512 dimensions for the planned benchmark.
- **Configuration, not code:** the embedding region, model id and dimension are settings, read by `TitanEmbeddingsProvider` (`packages/ai`). Moving to an in-region model later means adding an adapter and changing those settings; call sites are untouched.

### 2026-10-27 — Retriever design (M3 slice 2)

- **Supersession lives in DynamoDB, not in vectors.**
  - The retriever lists the edition's documents, keeps those that are `CURRENT` and belong to an enabled content package, and filters the vector query to those `documentId`s.
  - Vectors never change when a document is superseded or reinstated, so publishing stays one DynamoDB transaction (ADR-0008) with no second store to keep in step.
  - A reinstated document's vectors are simply matched again.
- **Pre-filtering.**
  - Queries use `queryMode: 'ENHANCED'`, which applies the filter before the search, so a narrow filter still returns its true top K.
  - The filter is `gameId` `$eq`, `editionId` `$eq` and `documentId` `$in`. ENHANCED queries allow 100 filter values, so this caps an edition at 98 current documents across the enabled content. The adapter refuses a larger filter instead of sending it.
- **Metadata layout.**
  - Vector key = `chunkId`.
  - Filterable: `gameId`, `editionId`, `contentId`, `documentId`, `authority` and `sourceType`, well under the 2 KB limit.
  - Non-filterable (declared when the index is created): `text`, `headingPath`, `pageStart`, `pageEnd` and `documentVersion`. These let a query return citable evidence without reading S3 or DynamoDB.
- **A second check.** The retriever re-checks every hit against its filter and the enabled content before returning it.
- **Evidence reducer.** `selectEvidence` keeps the top N by score. MMR or a reranker replaces it only if the evals show a gain.
