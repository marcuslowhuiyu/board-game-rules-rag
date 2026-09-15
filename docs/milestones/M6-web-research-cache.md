# Milestone 6 — Web Research, Errata Discovery & Ruling Cache

**Master plan reference:** §10, §24–§28, §66. **ADRs:** 0002, 0005. **Depends on:** M5.

## Objective

When local evidence is insufficient, escalate to bounded external research, promote authoritative discoveries into the ingestion pipeline, and cache expensive rulings so obscure repeat questions become cheap. This milestone closes the answer pipeline diagram in `MASTER_PLAN.md` §23.

## Deliverables

Web research abstraction:

- `WebSearchProvider` interface in `packages/ai` (or a new `packages/research`).
- **AgentCore Web Search adapter** as the primary implementation. If AgentCore is not viable in the target region at implementation time, wire a fallback provider (record in a follow-up ADR and update ADR-0005's "Follow-up" section).
- The rest of the app depends only on the interface — no AgentCore-specific types leak out.

Research loop:

- Deterministic loop controlled by the application, per `MASTER_PLAN.md` §24. Bounds enforced from config:
  - `maxResearchIterations`, `maxSearches`, `maxFetchedPages`, `maxResearchTokens`.
- Priority order (`MASTER_PLAN.md` §25): official domains → BGG → Reddit → general web.
- Fetched pages passed to the model as untrusted data blocks. No merging into system instructions.
- Budget exhaustion → `INCONCLUSIVE`.

Automatic errata / FAQ discovery:

- On new game creation (or explicit refresh), fire a targeted search for FAQ / Errata / Living Rules / Rules Update / Official Rules Reference (`MASTER_PLAN.md` §27).
- Discovered documents with high-confidence provenance are pushed into the M2 ingestion pipeline as new sources; low-confidence hits are stored as "candidates" and surfaced in the Add-Game UI for confirmation.
- Ingesting a new errata document bumps `knowledgeRevision`.

Ruling cache in `packages/persistence`:

- New DynamoDB table `Rulings` with shape from `MASTER_PLAN.md` §28.
- Semantic index over `canonicalQuestion` (S3 Vectors, separate logical index).
- Cache lookup precedes web research. Match requires: game / edition / compatible content config / `knowledgeRevision` current / semantic similarity ≥ configured threshold.
- Newly researched rulings are persisted; the `configurationFingerprint` from M1 keys reuse.

Pipeline wiring:

- The full `MASTER_PLAN.md` §23 flow is now active:

  ```
  question → retrieve → assess
    → sufficient?  yes → generate → validate → return
                    no → cache lookup
                         hit & valid? → generate/return cached
                         miss        → bounded research
                                       → generate → validate → cache & return
                                       → budget exhausted → INCONCLUSIVE
  ```

Telemetry:

- Add `researchTokens`, `researchIterations`, `webSearchCount`, `cacheHitRate` to the observability set (`MASTER_PLAN.md` §50).

Frontend:

- Answer UI distinguishes rulings sourced from local rules vs research-derived vs cache-reused, without misrepresenting authority.
- Citations link to canonical URLs when research provided them.

Evaluation:

- Add cases that require research (`MASTER_PLAN.md` §35): expansion interactions, promo interactions, questions requiring designer clarification.
- Verify a repeated obscure question uses the cache and does not perform another web search.

## Explicitly out of scope

- Full model benchmark and judge (M7).
- Public-facing controls on research use (deferred to M9/M10).

## Verification

1. A question with clearly local answer never triggers research (log assertion via a smoke case).
2. A question requiring an errata that has been auto-discovered and ingested is answered from local sources with the errata cited.
3. A question that neither local sources nor cache can resolve triggers a bounded research pass; verify total tokens and iterations stay within configured bounds.
4. Re-asking the same obscure question reuses the cached ruling; `webSearchCount` unchanged.
5. Bumping `knowledgeRevision` (via a new errata ingest) invalidates affected cached rulings; the next ask re-researches.
6. Nightly eval report now includes research and cache metrics.

## Definition of Done

`MASTER_PLAN.md` §71. Includes research- and cache-specific eval cases and an updated observability dashboard.
