# Current State

_Last updated: 2026-10-27 (M3 slices 1–4 done; slice 5 baseline recorded; FAQ cases and the case review pending)_

## Current milestone

**Milestone 3 — Embeddings, Retrieval & Evaluation Foundation**, on `feature/m03-embeddings` (draft PR #26). It is built in slices, each reviewed before the next. Slices 1–3 are done, Codex-reviewed and in review on the PR; slice 3 is deployed to dev from the branch. Slice 4 is built, and slice 5's dimension comparison and baseline are done (see below).

1. **`EmbeddingsProvider` plus the Titan Text Embeddings V2 adapter** (`packages/ai`). This slice is done and in review. The region, model id and dimension (256, 512 or 1024) are constructor options supplied from config. Titan has no batch call on demand, so a batch makes one request per text, with bounded concurrency (default 4), SDK retries for throttling and checks on vector size. It returns input-token counts for cost reporting.
2. **`RulesRetriever`** (`packages/retrieval`). Done; in review.
   - **`VectorRulesRetriever`:** every query needs a game, an edition, non-empty enabled content and question text. It searches only CURRENT documents of the enabled content (looked up in DynamoDB), then re-checks every hit against that filter.
   - **Vector stores:** `S3VectorIndex` uses pre-filtered (`ENHANCED`) queries and writes in batches of 500. `InMemoryVectorIndex` serves tests.
   - **`selectEvidence`:** keeps the top N candidates by score.
   - **Tests:** seeded property tests check that a disabled promo, another edition or a superseded document never appears in results. Design: ADR-0002 revision 2026-10-27.
3. **EMBED and INDEX stages.** Done; in review.
   - **Stages:** EMBED embeds each chunk with a game/content/section prefix, and INDEX writes the vectors to S3 Vectors.
   - **Infrastructure (CDK):** a vector bucket and a cosine `float32` index named `rule-chunks-titan-v2-1024`, with the chunk-body metadata keys non-filterable. The stage runner has least-privilege IAM (Titan in Sydney, `PutVectors` on that index) and its timeout is now 120 s.
   - **Re-uploads:** a duplicate or reinstated upload now re-indexes the existing document before FINALIZE. That is how the three dev rulebooks, ingested before M3, got their vectors. Design: ADR-0008 revision 2026-10-27.
   - **Lambdas bundle the AWS SDK**, because the runtime's copy may predate S3 Vectors.
4. **Retrieval eval framework and dataset.** Done, apart from the FAQ cases.
   - **Design:** `docs/superpowers/specs/2026-10-27-m3-retrieval-eval-design.md`.
   - **Tiers:** simple cases pass if their one required rule is in the top 3 (bar ≥ 90 %). Complex cases pass only if *all* their evidence is in the top 10 (bar ≥ 70 %). Routing simple and complex questions differently is the operator's direction for M4; these per-tier numbers are its evidence.
   - **Dataset:** 42 cases paraphrased from BGG rules threads (15 SETI, 13 Ticket to Ride, 14 Wingspan; 16 complex), each phrase checked against the fresh ingest. Usage: `evals/README.md`.
   - **Regression subset:** an AWS-free subset runs inside `pnpm test`. The full eval is a local command, not a CI job (ADR-0009).
5. **Baseline and 512 vs 1024 dimensions.** Done; see "Slice 5 baseline" below.
   - **Tooling:** `eval:retrieval --dimensions <n>` re-embeds the eval games' current chunks into an exact in-memory index, so dimensions compare on identical chunks without a second deployed index. The EMBED stage and the eval share `embeddingText` and `chunkVectorMetadata` (now in `@bgr/retrieval`).

Spec: `docs/milestones/M3-embeddings-retrieval.md`. Decision: `docs/adr/0002-vector-store.md` (revision 2026-10-26: S3 Vectors in `ap-southeast-1`, Titan V2 in `ap-southeast-2`).

### Slice 3 in dev (2026-10-27)

Deployed from the branch with `pnpm -C infrastructure/cdk deploy:dev` (the next merge to `main` redeploys through CI).

- **Backfill:** SETI, Ticket to Ride and Wingspan were re-uploaded and are now indexed (201, 10 and 183 chunks).
  - The first attempt found a real bug: S3 Vectors rejects empty metadata arrays, and a PDF's first chunk has no heading.
  - The fix (`2d595c9`) omits an empty `headingPath` on write and reads it back as `[]`.
- **Live retrieval check:** a question embedded with Titan in Sydney and run as a filtered query against S3 Vectors in Singapore returns the right rules:
  - Wingspan "tucking power" → *Tucked Cards* (0.775).
  - SETI "launch a probe" → "Pay 2 credits to launch a probe".
  - Ticket to Ride "longest path" → *Route Scoring Table*.
- **Titan check:** the adapter returned unit vectors at 512 and 1024 dimensions. A question scored 0.75 against its answer, and 0.17 (512) or 0.08 (1024) against an unrelated rule.
- **Not yet exercised live:**
  - The app's own query path (`queryMode: 'ENHANCED'` plus the `gameId`/`editionId` filter). The local AWS CLI is too old to send the query mode or report the index mode.
  - The slice 4 eval runner will exercise it.
- **The dev copies of SETI and Ticket to Ride still carry their pre-M2-T1 chunking.** Identical bytes are never re-chunked, and you can see it in the results: misfiled "1 Longest Continuous Path" headings and a letter-spaced "L AUNCH A PROBE" heading-only chunk.

### Dev resources

API: `https://d1wbjv971ead09.cloudfront.net/api`. Vector index: `rule-chunks-titan-v2-1024` in the stack's `RuleVectorBucket`. Games:

| Game | gameId | editionId | contentId (base) | CURRENT document |
|---|---|---|---|---|
| SETI | `g_f54d4aca549948a2` | `e_3cea0970c9754acb` | `c_5daa0a1ca54e4820` | `doc_e42aed216f5c43bb` |
| Ticket to Ride | `g_4d78f6f49a104f4b` | `e_a746242c509e465d` | `c_3f530fd080844782` | `doc_7a85f4470bda4983` |
| Wingspan (Rulepop URL) | `g_7955d4ac94a74025` | `e_907eee2eead94e37` | `c_68c3c6f0951a48da` | `doc_7883959006c3439b` |

Real rulebooks stay out of the repo. SETI comes from the operator's local copy, Ticket to Ride from the Days of Wonder PDF, and Wingspan from `https://wingspan.rulepop.com/`.

### Slice 4 in dev (2026-10-27)

- **Eval games**, ingested through the public API with today's chunking: SETI (eval) 78 chunks, Ticket to Ride (eval) 7, Wingspan (eval) 191 (rulepop 185 plus the Stonemaier rules page 6, re-ingested after the parser fix). Ids are in `evals/config/eval-games.dev.json`. The old dev games are untouched.
- **First live run** (1024 dimensions, topK 15). This is also the first live run of the `ENHANCED` filtered query path, which works:

| Game | Cases | R@1 | R@3 | R@5 | MRR | Simple pass | Complex full coverage |
|---|---|---|---|---|---|---|---|
| SETI | 15 | 0.54 | 0.78 | 0.84 | 0.74 | 89 % | 67 % |
| Ticket to Ride (small corpus, excluded from bars) | 13 | 0.73 | 0.97 | 1.00 | 0.87 | 100 % | 100 % |
| Wingspan (before the parser fix; corpus included 1 reader-comment chunk) | 14 | 0.46 | 0.82 | 0.82 | 0.72 | 89 % | 80 % |

  Tiers: simple 89 % (16/18, bar 90 %, ❌ by one case), complex 73 % (8/11, bar 70 %, ✅). Failures: `seti-rotate-icon-once`, `wingspan-pink-after-last-turn`, `seti-computer-tech-under-data`, `seti-hand-limit`, `wingspan-tiebreak-cached`.
- **Bug found and fixed:** the HTML parser took a WordPress reader comment as the whole page (ADR-0008 revision 2026-10-27). Deployed to dev from the branch on 2026-10-27; the re-ingested Stonemaier page is now 6 chunks (`doc_cd85e7983cba48a7`).
- **BGG access rule:** questions are paraphrased with a thread link. No requests go through BGG's internal `api.geekdo.com` API; M6 forum search must use the official XML API with a token.
- **SETI heading paths are often wrong in the fresh ingest** (missions under "END-OF-GAME SCORING CARDS", scan rules under "JUPIT"), so SETI evidence is matched by phrase only.

### Slice 5 baseline (2026-10-27)

Same 42 cases and 276 chunks for all three runs, after the HTML parser fix was deployed and the eval games re-ingested (the Stonemaier page is now 6 chunks).

| Run | Simple (top 3, bar 90 %) | Complex (all in top 10, bar 70 %) | SETI R@3 / MRR | Wingspan R@3 / MRR |
|---|---|---|---|---|
| Live S3 Vectors, 1024 | 89 % (16/18) ❌ | 73 % (8/11) ✅ | 0.78 / 0.74 | 0.82 / 0.76 |
| Local exact, 1024 | 89 % (16/18) ❌ | 73 % (8/11) ✅ | 0.78 / 0.74 | 0.82 / 0.76 |
| Local exact, 512 | 78 % (14/18) ❌ | 91 % (10/11) ✅ | 0.74 / 0.73 | 0.68 / 0.70 |

Ticket to Ride (7 chunks, excluded from the bars) scores the same in all three: R@3 0.97, MRR 0.87, every case passing.

- **The live index matches exact search.** The local 1024 run is identical to the live one, case for case, so S3 Vectors' approximate search costs nothing measurable at this size, and the local index is a faithful stand-in.
- **Decision: keep 1024 dimensions.** 512 passes the same total (24 of 29 counted cases) but moves two failures into the simple tier, the tier that is already short of its bar. Storage and query costs at this scale are negligible either way, and 1024 needs no re-index. With 18 simple and 11 complex cases, one case moves a tier by 6–9 points, so the difference is within noise. Revisit only if the dataset grows.
- **Decision: don't fix the PDF heading limits before M4.** Every required item of the five failing cases is retrieved (ranks 4–15); they fail on ranking, not on missing chunks. Of SETI's 78 chunks, 4 have letter-spaced headings and 1 has none. The failing SETI evidence sits under correct headings ("RESEARCH A TECH") or under letter-spaced ones whose fixed text wouldn't match the question better ("BET WEEN ROUNDS" for a hand-limit question). One bonus rule is filed under "ROTATING THE SOL AR SYSTEM" instead of its tech section; that is a missed heading, not letter-spacing. Ranking improvements in M4 (query handling, reranking, routing by tier) are the better lever. Revisit if M4's answer evals show wrong section citations.
- **The parser fix** raised Wingspan's R@1 from 0.46 to 0.54 but changed no pass/fail result. The simple tier stays one case short of its bar; M4's ranking work is where that gets fixed.
- **Failures (1024):** simple `seti-rotate-icon-once` (rank 4), `wingspan-pink-after-last-turn` (rank 8); complex `seti-computer-tech-under-data` (8, 12), `seti-hand-limit` (15, 15), `wingspan-tiebreak-cached` (13, 1).

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
- **ADR-0002 (revised 2026-10-26/27)** — S3 Vectors in `ap-southeast-1` behind `RulesRetriever`; Titan Text Embeddings V2 called in `ap-southeast-2`; embedding region, model id and dimension are config; supersession decided in DynamoDB and applied as a `documentId` pre-filter; chunk text stored as non-filterable vector metadata.
- **ADR-0003** — `RulesModel` interface + Bedrock Converse adapter default.
- **ADR-0004** — DynamoDB full log + rolling summary + recent turns, 24h TTL.
- **ADR-0005** — Bounded `WebSearchProvider` loop with AgentCore adapter.
- **ADR-0006** — DynamoDB multi-table design for M1 entities.
- **ADR-0007** — Same-origin routing via CloudFront `/api/*` + first-party `SameSite=Lax` session cookie.
- **ADR-0008 (revised 2026-09-17; review-fix revisions 2026-10-21/22)** — Ingestion pipeline: Step Functions + one stage-runner Lambda + Choice-based short-circuit + `MarkJobFailed` failure path; deterministic PDF-first; `TransactWriteItems`-based atomic publish; content-hash dedup scoped to `(game, edition, contentId, hash)`; manual redirect SSRF handling; quality gate at PARSE; storage lifecycle keeps raw/ + normalized/ retained and expires only `stage-state/ingestion/` (7d) and `temporary/` (1d), with no nested rule prefixes; ingestion-bucket CORS pinned to the CloudFront domain. M3 revision (2026-10-27): EMBED/INDEX stages, re-uploads re-index, AWS SDK bundled into Lambdas.

- **ADR-0009 (revised 2026-10-27)** — CI runs on a minimal Actions budget: PR-only, skips drafts and docs-only changes. `main` is protected: PRs only, the `Lint / Typecheck / Test / Synth` check is required (also for admins), and no force pushes. `ci-docs.yml` reports that check on docs-only PRs. GitHub requires every same-named check to pass, so on mixed PRs the real job still gates the merge.

## Known issues / open questions

Full tracker: `docs/CONTRADICTIONS_AND_GAPS.md`.

- **G4 (AgentCore regional availability in `ap-southeast-1`).** Still unverified; verify before M6. G3 is resolved (ADR-0002).
- **DNS rebinding on URL ingestion** — mitigated at validation time (resolved IPs re-checked) but the subsequent `fetch()` performs its own resolution; a custom `undici.Agent` with a pinned resolver would fully close this. Tracked as an M2 residual risk in ADR-0008 §SSRF.
- **No GSI on the documents table** — dev-scale scan with FilterExpression is fine at M2. Upgrade path noted.
- **Fallback parser is a stub** — `createStubFallbackParser` throws. OCR/AI deferred.
- **`InMemorySessionsRepository`'s TTL check uses wall-clock time** — tests that hardcode a past NOW would falsely see sessions as expired; worked around by using a far-future NOW. Consider clock-injecting in a later cleanup.
- **No static security analysis.** CodeQL was removed in ADR-0009 while the repo was private. The repo is now public (recreated 2026-10-21), so CodeQL is free and can be reinstated.
- **PDF extraction limits seen on real rulebooks (deferred past M4's start).** Large display fonts come out letter-spaced ("PL AYER PIECES", "BET WEEN ROUNDS"), and mixed-case headings (Ticket to Ride's "Claiming a Route") are not detected, so that document's rules carry an empty heading path. Both need font-size and position data from pdf.js rather than plain text; that is a bigger change. The slice 5 baseline shows the failing cases are ranking problems, not heading problems (see "Slice 5 baseline"), so this waits for evidence from M4's answer evals.

## Requires operator decision, if you want them

- **A second region for AgentCore** — pending G4 verification.
- **Slice 4 FAQ sources.** Download into `~/bgr-eval-sources/` by hand, because BGG blocks automated downloads. Then unskip them in `evals/config/eval-sources.json`, re-run `eval:ingest`, and add the 10 deferred FAQ cases from the candidates file. The files:
  - the SETI CGE FAQ as `seti-faq.pdf` (BGG filepage 289980);
  - an official copy of the Wingspan appendix as `wingspan-appendix.pdf`. The only copy found so far is a third-party rehost.

## Next expected work

**Finish M3:**
- the operator reviews the 42 cases;
- add the FAQ cases once the PDFs arrive;
- then take PR #26 out of draft for the final CI run, Codex review of the whole milestone and merge.

**After M3:**
- A follow-up PR for the deferred minor review items (`M2-REVIEW-FIXES.md` §M2-R4).
- Open Dependabot PRs: #24 (grouped npm bump, superseded by #23/#25; close it) and #18 (GitHub Actions bumps).
