# M3 slice 4 — Retrieval eval framework and dataset

_Design, 2026-10-27. Milestone spec: `docs/milestones/M3-embeddings-retrieval.md`. Status: draft for operator approval._

## Why

The product's promise is a rules referee that is right, and says so only when it is sure. A ruling on a hard question, say "what order do things resolve in when one action triggers several effects?", is only trustworthy if every rule that applies was in front of the model. In SETI that one question needs rules from three sections (Milestones, Neutral milestones, Discovery), and the official FAQ settles parts the rulebook leaves open.

This slice measures how well retrieval finds that evidence, before any answering is built on it (M4). Its numbers also decide two later questions: whether the PDF heading limits must be fixed before M4, and whether M4 needs a router that sends complex questions down a deeper path.

## Goals

1. A dataset of about 45 retrieval cases drawn from real player questions on BoardGameGeek, for SETI, Ticket to Ride and Wingspan.
2. Two tiers of case, each with its own pass bar:
   - **Simple:** one rule answers it.
   - **Complex:** it needs rules from two or more sections, or a rule plus an official FAQ ruling.
3. A runner, `evals/run-retrieval-eval.ts`, that reports Recall@1/3/5, MRR and the irrelevant-result rate per game and per tier, plus full-coverage rates for complex cases. It writes a JSON report to `evals/reports/` (gitignored) and has a `--markdown` mode.
4. Fresh eval games in dev, ingested with today's chunking (M2-T1), including the official FAQs where they exist.
5. A fast, deterministic regression subset that needs no AWS and runs on PRs touching `packages/retrieval`, `packages/ai` or `packages/ingestion`.

## Non-goals

- **Answer generation and routing.** Both are M4. Routing simple and complex questions down different paths, with a different confidence bar for each, is the operator's stated direction. This slice only supplies the per-tier numbers that justify it, matching MASTER_PLAN §32 ("benchmark first"). M4 records the router in its own ADR.
- **Searching the web, forums or errata at question time.** That is M6. The case format leaves room for that evidence (below), but nothing here searches for it.
- **Fixing chunking or the PDF heading limits.** Slice 5 decides that from the baseline.
- **Expansions, alien species sheets and per-card text.** None are in the ingested sources, so questions that need them are left out.

## Anti-goals: it fails even if it runs

- Scores that flatter retrieval. Example: the dev Ticket to Ride copy has 10 chunks, with all the gameplay rules in 3 of them, so almost any query "finds" the right chunk. The report must make such cases visible, as must cases that pass for the wrong reason.
- Cases tied to chunk ids. Re-chunking must not break the dataset.
- Cases whose "right answer" is a community opinion or is disputed. Retrieval cannot be scored against an answer that does not exist.
- Copying forum posts into a public repo. Questions are paraphrased, and each case links to its thread.

## Decisions made with the operator

| Decision | Choice |
|---|---|
| Source of questions | Real BGG rules-forum threads, paraphrased, weighted toward questions players actually get stuck on |
| Complex-case success | **All** required evidence must be retrieved; partial coverage is reported but does not pass |
| Simple-tier bar | Required evidence in the top 3 for ≥ 90 % of simple cases |
| Complex-tier bar | All required evidence in the top 10 for ≥ 70 % of complex cases |
| Official FAQs | Ingested into the eval games alongside the rulebooks. This is in M3 scope: only *automatic* errata discovery is M6, and a hand-ingested document already carries `sourceType: FAQ` and `authority: OFFICIAL_ERRATA` through CLASSIFY |
| Routing | Decided and built in M4; this slice provides the evidence |

The bars are starting guesses, not measurements. Slice 5 records the real baseline, and a shortfall there is the signal to fix chunking or retrieval before M4.

## Sources

| Game | Rulebook | Official FAQ / errata to ingest |
|---|---|---|
| SETI | CGE base rulebook PDF (operator's copy) | CGE Official FAQ and card clarifications (BGG thread 3392878, PDF at filepage 289980) |
| Ticket to Ride | Days of Wonder rules PDF | None found. Two Days of Wonder staff rulings exist only as forum posts, so they wait for M6 |
| Wingspan | `https://wingspan.rulepop.com/` | The Stonemaier rules and FAQ page; the printed base appendix PDF (it has rules rulepop lacks, such as the failed-predator discard) |

BGG blocks automated downloads, so the operator downloads the FAQ PDFs by hand. Until they arrive, the plan builds and verifies the rulebook-only cases first and adds the FAQ cases afterwards.

**Source types.** _Builder's call, made at design review._ FINALIZE treats a new document as superseding the CURRENT one with the same (edition, contentId, sourceType). Each eval game has a single "base" content package, so every document in a game must have a **distinct `sourceType`**, or one silently supersedes another and vanishes from retrieval. The ingest script asserts this before it uploads anything. Assignments:

| Game | Document | sourceType | authority |
|---|---|---|---|
| SETI | CGE rulebook PDF | `RULEBOOK` | `OFFICIAL_RULES` |
| SETI | CGE FAQ PDF | `FAQ` | `OFFICIAL_ERRATA` |
| Ticket to Ride | Days of Wonder rules PDF | `RULEBOOK` | `OFFICIAL_RULES` |
| Wingspan | rulepop site | `RULES_REFERENCE` | as the current dev ingest classifies it |
| Wingspan | printed appendix PDF | `RULEBOOK` | `OFFICIAL_RULES` |
| Wingspan | Stonemaier rules and FAQ page | `FAQ` | `OFFICIAL_ERRATA` | Forum threads, designer posts and community answers are **not** ingested.

**BGG access.** BGG's official XML API now needs a registered token. Its pages refuse automated fetches. Its internal JSON API answers without login, but using it to get around those controls is not acceptable, and no further requests will go through it. The question research for this slice has already been gathered. M6 forum search must use the official API with a token.

## Case format

JSONL, one case per line, in `evals/datasets/retrieval/<game>.jsonl`.

```jsonc
{
  "id": "seti-milestone-order",
  "game": "seti",                    // resolved to ids by the eval-games config, not hard-coded
  "edition": "base",
  "enabledContent": ["base"],
  "tier": "complex",                 // "simple" | "complex"
  "question": "In one turn I pass a gold milestone and a neutral milestone, and a species is discovered. What order do these resolve in?",
  "requiredEvidence": [              // ALL must be retrieved for a complex case to pass
    { "key": "seti/milestones/between-turns", "heading": "Milestones",
      "phrase": "resolved between turns, after the current player has finished" },
    { "key": "seti/milestones/neutral-last", "heading": "Multiple milestones",
      "phrase": "it is always resolved last" },
    { "key": "seti/discovery/milestones-first", "heading": "Discovery",
      "phrase": "resolve them before resolving the discovery" }
  ],
  "source": { "url": "https://boardgamegeek.com/thread/3632508", "title": "Non-Player Agency Markers" },
  "notes": "",
  "futureEvidence": []               // reserved for M6: errata/forum/designer evidence; ignored by this runner
}
```

- **Evidence is a stable rule key**, matched by heading plus key phrase, never by chunk id. A retrieved chunk satisfies an item when its text contains the phrase. The phrase comparison ignores case and whitespace, and collapses letter-spaced headings such as "L AUNCH A PROBE". When the heading is present, the chunk's heading path must contain it.
- **Required vs supporting evidence.** _Builder's call, made at design review._ Each item has `"required": true | false`.
  - **Tier follows the required count.** A **simple** case has exactly **one** required item. A case that needs two or more, including a rule plus the FAQ ruling that settles it, is **complex** by definition, matching the operator's rule that a confident answer needs *all* the evidence. Candidates S8, S9 and S10 therefore move to the complex tier.
  - **Supporting items** are other passages that say the same thing (for example the second phrase in S14, W3 and W6). They are reported as hits, but they do not count toward pass/fail.
- **Evidence from an official FAQ** carries `"authority": "OFFICIAL_ERRATA"`, so the report can show whether FAQ rulings come back alongside the rule they modify.
- A pinned schema (zod) validates every line before a run; a malformed case fails the run.

## Scoring

Per case, retrieval returns the ranked candidates (the retriever's 10–15) before `selectEvidence` trims them.

- **Recall@k** (k = 1, 3, 5, 10): the share of required evidence items found in the top k. For a simple case this is 0 or 1.
- **Full coverage@k:** the case passes only if *every* item is found in the top k. This is the complex-tier pass metric.
- **MRR:** reciprocal rank of the first required item.
- **Irrelevant-result rate:** the share of top-5 results that match no required item of the case. A rough signal only, because a hit can be relevant without being listed.
- **Reported per game and per tier.** The tier bars are judged per tier across all games.
- **Small corpora.** _Builder's call, made at design review._ A game whose eval ingest has fewer than **30 chunks** (Ticket to Ride, about 7 after M2-T1) is excluded from the tier bars, because recall there is trivial. It is still scored and reported in its own row, marked "small corpus". The threshold is config, not code.

## Dataset

The research found 56 candidates (24 SETI, 15 Ticket to Ride, 17 Wingspan). The builder trims these to about 45, roughly one third complex, by dropping:

- disputed or community-only answers (for example, banking probe movement in SETI, and the reshuffle-or-wipe question in Ticket to Ride);
- questions needing sources not ingested (alien species sheets, card text, expansions);
- Wingspan questions whose thread could not be opened, unless the rule itself is unambiguous in the source.

Every evidence phrase is checked against the freshly ingested text before the dataset is committed. The operator reviews the case list before the baseline is recorded.

The candidates, with thread links, key phrases, old chunk numbers and a keep/drop/faq status for each, are in `2026-10-27-m3-retrieval-eval-candidates.md`.

## Infrastructure and runs

- **Eval games.** A script creates new games named "SETI (eval)", "Ticket to Ride (eval)" and "Wingspan (eval)" in dev through the public API. It then ingests the rulebooks and FAQs into them. It is idempotent: it reuses existing eval games, and duplicate uploads short-circuit. It writes the resulting ids to `evals/config/eval-games.dev.json` (committed; ids are not secrets). The old dev games are left alone.
- **Full eval.** Runs on demand, locally or via `workflow_dispatch`, against dev with the real `VectorRulesRetriever`, `S3VectorIndex` and Titan embedder. It reads model, region and dimension from config, not code. This is also the first live run of the `ENHANCED` query path.
- **PR regression subset.** A handful of cases runs against `InMemoryVectorIndex` with a deterministic fake embedder over committed fixture chunks. The repo is public and real rulebook text stays out of it (`CURRENT_STATE.md`; `evals/fixtures/ingestion/README.md`), so the subset uses its own **synthetic** mini-corpus and its own cases, kept separate from the real dataset. The real dataset commits only short key phrases (≤ 15 words each) as evidence anchors. It must run in seconds with no AWS and no network, as part of `pnpm test` (so it rides the existing CI job and adds no new workflow minutes). It guards the scoring code and the retriever's filtering, not embedding quality.

## Left to the builder

- Exact file layout under `evals/`, and how the runner is invoked (a `pnpm` script).
- How the fake embedder makes the subset meaningful (for example, a bag-of-words hash).
- The report's JSON shape and the markdown table layout.
- Which cases form the PR subset.
- Whether the full eval's `workflow_dispatch` job lands now or as a documented local command only. CI minutes are tight (ADR-0009).

## Follow-ups this slice records

- **M4:** the routing ADR, using the per-tier numbers.
- **M6:** forum search through BGG's official API with a token, and ingesting the Ticket to Ride staff rulings and the Wingspan "compiled official rulings" thread as `futureEvidence`.
- **Slice 5:** baseline in `CURRENT_STATE.md`, 512 vs 1024 dimensions, and the decision on the PDF heading limits.
