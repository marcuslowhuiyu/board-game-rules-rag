# Current State

_Last updated: 2026-10-27 (M3 slice 1: embeddings provider)_

## Current milestone

**Milestone 3 — Embeddings, Retrieval & Evaluation Foundation**, on `feature/m03-embeddings`. It is built in slices, each reviewed before the next:

1. **`EmbeddingsProvider` plus the Titan Text Embeddings V2 adapter** (`packages/ai`). This slice is done and in review. The region, model id and dimension (256, 512 or 1024) are constructor options supplied from config. Titan has no batch call on demand, so a batch makes one request per text, with bounded concurrency (default 4), SDK retries for throttling and checks on vector size. It returns input-token counts for cost reporting.
2. `RulesRetriever` on S3 Vectors, with mandatory game/edition/content filters and supersession filtering.
3. Enable the EMBED and INDEX ingestion stages.
4. Retrieval eval framework plus 30–50 cases for SETI, Ticket to Ride and Wingspan. Evals run on demand; the nightly schedule in the spec is dropped to save CI minutes (ADR-0009), and PRs run a small regression subset.
5. Baseline metrics recorded here.

Spec: `docs/milestones/M3-embeddings-retrieval.md`. Decision: `docs/adr/0002-vector-store.md` (revision 2026-10-26: S3 Vectors in `ap-southeast-1`, Titan V2 in `ap-southeast-2`).

## Completed work

- **Milestone 0 — Repository & Engineering Foundation.** Merged.
- **Milestone 1 — Domain Model, Game Catalog & Sessions.** Merged as PR #6 / commit `6b50738`.
- **Milestone 2 — Document Ingestion.** Merged 2026-10-22 as PR #1 (`b9962f2`; PR #7 before the repo was recreated), after review-fix slices R1–R4 (`docs/milestones/M2-REVIEW-FIXES.md`). Chunk tuning followed as M2-T1, PR #22 (`829c628`). Design: ADR-0008.
- **Toolchain and dependency upgrades** (2026-10-26): Vitest 4, Vite 7, esbuild 0.28 (PR #23); zod 4 and an undici patch (PR #25). See the ADR-0001 revisions.

## M2 reference: real documents in dev

### Acceptance (2026-10-23) — passed

Run against the deployed stack through the public API, the same calls the browser makes. Real rulebooks stay out of the repo.

| Check | Result |
|---|---|
| PDF #1: SETI base rules (21.9 MB, illustrated) via presigned upload | SUCCEEDED, 201 chunks, garbled 0 %, not flagged as a scan |
| PDF #2: Ticket to Ride rules (Days of Wonder, 3.5 MB) | SUCCEEDED, 10 chunks |
| URL: `https://wingspan.rulepop.com/` (about 108k chars) | SUCCEEDED, 183 chunks, nested sections preserved |
| Supersede v1 → v2 | v1 SUPERSEDED, v2 CURRENT, `knowledgeRevision` 1 → 2 |
| Re-upload v1 (R4 reinstate) | v1 CURRENT again with its original chunks, v2 SUPERSEDED, revision 3 |
| Re-upload v1 while CURRENT | duplicate, revision unchanged |

The garbled-text threshold (5 %) needs no change: every real document measured 0 %. Chunk quality did need tuning, and that is M2-T1.

### M2-T1 chunk tuning

Measured with a local harness that runs the real extractor, parser and chunker on the same three documents (before → after):

| Document | chunks | tiny (< 20 tokens) | well-sized (100–700) |
|---|---|---|---|
| SETI | 201 → 78 | 106 → 9 | 48 → 46 |
| Ticket to Ride | 10 → 7 | 3 → 0 | 6 → 6 |
| Wingspan (HTML) | 183 → 185 | 5 → 4 | 65 → 76 |

Each fix has a test that failed first, using real lines from these documents:

1. **PDF numeric headings must look like section numbers.** Previously any line starting with a digit counted, including "48 tech tiles", "2 data." and "1. The first time, rotate disc 1…". Ticket to Ride's core rules were filed under "1 Longest Continuous Path". A numeric heading now needs "1." or "2.1" style numbering, a short capitalised title and no sentence punctuation at the end.
2. **Body-less heading runs fold into the next section.** A parent heading followed directly by a child, or a diagram's labels, no longer produces heading-only chunks.
3. **HTML icons are read by their accessible name:** `img` alt, `svg` aria-label or title, or the referenced `<symbol>`'s title or id. Rulepop's "[bird] in [forest]" headings had come out as "in".

The M2-T1 Codex review caught two more issues, both fixed: a heading run could exceed the token cap, and visible SVG diagram text was dropped. 282 tests total.

## Active decisions

Load-bearing decisions from `docs/adr/`:

- **ADR-0001** — TypeScript strict, Node 22 LTS, pnpm 10, CDK v2 TypeScript.
- **ADR-0002 (revised 2026-10-26)** — S3 Vectors in `ap-southeast-1` behind `RulesRetriever`; Titan Text Embeddings V2 called in `ap-southeast-2`; embedding region, model id and dimension are config.
- **ADR-0003** — `RulesModel` interface + Bedrock Converse adapter default.
- **ADR-0004** — DynamoDB full log + rolling summary + recent turns, 24h TTL.
- **ADR-0005** — Bounded `WebSearchProvider` loop with AgentCore adapter.
- **ADR-0006** — DynamoDB multi-table design for M1 entities.
- **ADR-0007** — Same-origin routing via CloudFront `/api/*` + first-party `SameSite=Lax` session cookie.
- **ADR-0008 (revised 2026-09-17; review-fix revisions 2026-10-21/22)** — Ingestion pipeline: Step Functions + one stage-runner Lambda + Choice-based short-circuit + `MarkJobFailed` failure path; deterministic PDF-first; `TransactWriteItems`-based atomic publish; content-hash dedup scoped to `(game, edition, contentId, hash)`; manual redirect SSRF handling; quality gate at PARSE; storage lifecycle keeps raw/ + normalized/ retained and expires only `stage-state/ingestion/` (7d) and `temporary/` (1d), with no nested rule prefixes; ingestion-bucket CORS pinned to the CloudFront domain.

## Known issues / open questions

Full tracker: `docs/CONTRADICTIONS_AND_GAPS.md`.

- **G4 (AgentCore regional availability in `ap-southeast-1`).** Still unverified; verify before M6. G3 is resolved (ADR-0002).
- **The live Titan smoke check for slice 1 is pending.** The AWS session expired before it ran; the account itself reached Titan in Sydney on 2026-10-26.
- **DNS rebinding on URL ingestion** — mitigated at validation time (resolved IPs re-checked) but the subsequent `fetch()` performs its own resolution; a custom `undici.Agent` with a pinned resolver would fully close this. Tracked as an M2 residual risk in ADR-0008 §SSRF.
- **No GSI on the documents table** — dev-scale scan with FilterExpression is fine at M2. Upgrade path noted.
- **Fallback parser is a stub** — `createStubFallbackParser` throws. OCR/AI deferred.
- **`InMemorySessionsRepository`'s TTL check uses wall-clock time** — tests that hardcode a past NOW would falsely see sessions as expired; worked around by using a far-future NOW. Consider clock-injecting in a later cleanup.
- **No static security analysis.** CodeQL was removed in ADR-0009 while the repo was private. The repo is now public (recreated 2026-10-21), so CodeQL is free and can be reinstated.
- **PDF extraction limits seen on real rulebooks (deferred).** Large display fonts come out letter-spaced ("PL AYER PIECES", "BET WEEN ROUNDS"), and mixed-case headings (Ticket to Ride's "Claiming a Route") are not detected, so that document's rules carry an empty heading path. Both need font-size and position data from pdf.js rather than plain text; that is a bigger change, best done before M3 retrieval evals.

## Requires operator decision, if you want them

- **Branch protection on `main`.** Now available for free, because the repo is public. Requiring the `Lint / Typecheck / Test / Synth` check before merge would enforce the PR-and-CI workflow.
- **A second region for AgentCore** — pending G4 verification.

## Next expected work

- M3 slice 2: `RulesRetriever` on S3 Vectors.
- A follow-up PR for the deferred minor review items (`M2-REVIEW-FIXES.md` §M2-R4).
