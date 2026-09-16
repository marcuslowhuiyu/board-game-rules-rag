# Contradictions and Gaps in MASTER_PLAN.md

A running list of things the master plan leaves undecided, decides ambiguously, or asserts about services whose real availability must be verified. Update this file as items are resolved — do not delete resolved entries; move them to the "Resolved" section with a link to the ADR or milestone that closed them.

Each item names the section(s) of `MASTER_PLAN.md` that raised it, the impact, and where the resolution should live.

---

## Open — resolve during Milestone 0

### G3. Region availability of Amazon S3 Vectors
- **Where:** §10, §22 assume S3 Vectors in `ap-southeast-1`.
- **Impact:** S3 Vectors is a young service; ap-southeast-1 may not offer it initially. If not, retrieval infrastructure may need to run in a different region than the main workload.
- **Resolution home:** Requires AWS-console / API verification against a real account. **Deferred to first AWS bootstrap by the operator** — record outcome in ADR-0002 once the account is available.

### G4. Region availability of Bedrock AgentCore Web Search
- **Where:** §10 acknowledges that AgentCore regional availability may differ from the main workload region.
- **Impact:** May force a second CDK stack in a different region for research, or force a fallback web-search provider.
- **Resolution home:** Same as G3 — verify against a real account, then close via ADR-0005 or a follow-up ADR.

---

## Open — resolve during the milestone that needs them

### G5. Concrete Bedrock model id for "Nova 2 Lite"
- **Where:** §10, §32.
- **Impact:** "Nova 2 Lite" is a plan-time label. The concrete Bedrock model id must be pinned in config for the M4 adapter to work. It may not exist under exactly that name.
- **Resolution home:** M4. Record actual model id in configuration; note in `CURRENT_STATE.md`. If the family is different, note it in ADR-0003's follow-up.

### G6. Structured-output support across candidate models
- **Where:** §12 assumes Bedrock structured outputs "where supported"; §33 assumes Converse everywhere.
- **Impact:** Nova/Claude/other Bedrock models vary in Converse structured-output support. Adapter needs a validated JSON-mode fallback.
- **Resolution home:** M4 Bedrock adapter must handle both paths transparently. Called out in ADR-0003.

### G7. DynamoDB single-table vs multi-table design (partially resolved)
- **Where:** §10, §13, §28, §29, §45 — many entities, no data-model shape decided.
- **Impact:** Query patterns and cost.
- **Resolution home:** Decided for the M1 entity set (Games / Content / Sessions / Messages) in [ADR-0006](adr/0006-dynamodb-multi-table-catalog-sessions.md) — four separate on-demand tables. M6 entities (Rulings, IngestionJobs) are still open; revisit during that milestone.

### G8. Semantic index for cached rulings
- **Where:** §28 requires "Create a semantic index of cached ruling questions" without specifying the store.
- **Impact:** Additional S3 Vectors logical index vs. reuse of the rules index vs. a different store.
- **Resolution home:** M6. Default assumption in ADR-0005 is "same S3 Vectors service, separate logical index"; confirm and document.

### G9. Reranker choice
- **Where:** §21 mentions "optionally reduce/rerank"; §73 lists reranking as a benchmark item.
- **Impact:** Latency and cost per query.
- **Resolution home:** Introduce only if M7 benchmarks show pure retrieval quality is inadequate. Record decision in a follow-up ADR.

### G10. PDF fallback parser
- **Where:** §16 refers to an "enhanced document extraction mechanism" without naming it.
- **Impact:** Cost of ingestion for scanned or graphical rulebooks.
- **Resolution home:** Deferred — introduce with real failure data. When introduced, likely candidates: Amazon Textract, Bedrock Data Automation, or a multimodal Bedrock model. New ADR at that point.

### G11. `knowledgeRevision` type
- **Where:** §19, §28.
- **Impact:** Integer counter, ISO timestamp, or both? Affects cache invalidation semantics.
- **Resolution home:** M6. Default choice: monotonically increasing integer counter plus an `updatedAt` timestamp for humans. Document in the M6 spec or an ADR if it becomes contested.

### G12. Private-beta access control
- **Where:** §45 says no user accounts initially; §69/§70 defer accounts to M10.
- **Impact:** Between M8 and M10 the prod app is reachable — how is it restricted to the beta group? CloudFront basic auth, IP allowlist, Cognito with a whitelist, a shared invite token?
- **Resolution home:** M9. Record in the M9 spec and, if load-bearing, an ADR.

### G13. Session identity transport across origins — RESOLVED, see Resolved section below

### G14. `enabledContent` identifier shape — RESOLVED, see Resolved section below

### G15. Frontend styling and state-management choices — RESOLVED, see Resolved section below

---

## Resolved

### G1. Node.js runtime version
- **Resolved in Milestone 0.** Pinned to Node **22 LTS** (`.nvmrc = 22`, `engines.node = ">=22.0.0"`, CDK `NodejsFunction` `bundling.target = 'node22'`, Lambda `Runtime.NODEJS_22_X`). Recorded in [`docs/adr/0001-runtime-stack.md`](adr/0001-runtime-stack.md#revisions) under "Revisions".

### G2. Test framework, linter, formatter
- **Resolved in Milestone 0.** Confirmed **Vitest 2.x + ESLint 9 flat config + Prettier 3**. Recorded in the same ADR-0001 Revisions block.

### G13. Session identity transport across origins
- **Resolved in Milestone 1.** CloudFront now fronts both the SPA (`/*`) and the API (`/api/*`, with a viewer-request CloudFront Function that strips the `/api` prefix before forwarding to API Gateway). The browser reaches everything on the same origin, so the session cookie is a first-party `HttpOnly; Secure; SameSite=Lax` cookie, `fetch` uses `credentials: 'same-origin'`, and API Gateway has no CORS configuration. Recorded in [ADR-0007](adr/0007-cross-origin-session-cookies.md).

### G14. `enabledContent` identifier shape
- **Resolved in Milestone 1.** Runtime uses an opaque, generated `ContentId` (branded string) as the storage key everywhere in DynamoDB and vector metadata. Every `ContentPackage` also carries a human-readable `slug` unique per `(gameId, editionId)`; golden fixtures reference content by that slug, and the domain layer performs the slug→id lookup. See `packages/domain/src/content.ts`.

### G15. Frontend styling and state-management choices
- **Resolved in Milestone 1.** Vanilla CSS (a single `src/styles.css` with CSS variables + mobile-first widths) and local component state (no state-management library). Documented in `CURRENT_STATE.md`. Not ADR-worthy.
