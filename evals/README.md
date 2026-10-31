# Evaluation Framework

Retrieval evaluation (Milestone 3) and the answer eval with its answerer model comparison (Milestone 4). An LLM-as-judge harness arrives in M7. The design doc is in the private planning repo (`planning/specs/2026-10-27-m3-retrieval-eval-design.md`).

## What it measures

Each case is a real player question, paraphrased from a BoardGameGeek rules thread, with the evidence a correct answer needs.

- **Simple** cases have exactly one required piece of evidence. A simple case passes if it is in the top 3.
- **Complex** cases need two or more, often from different sections. A complex case passes only if **all** of them are in the top 10.

The bars are judged across games: simple ≥ 90 %, complex ≥ 70 % (`config/eval.config.json`). A game whose eval ingest has fewer than 30 chunks (Ticket to Ride) is reported but excluded from the bars, because retrieval over 7 chunks is trivial.

Reported per game: Recall@1/3/5, MRR, the irrelevant-result rate (top-5 chunks that match no evidence of the case; a rough signal only), empty retrievals, and the pass rates.

## Dataset format

`datasets/retrieval/<game>.jsonl`, one case per line, validated by `src/dataset/case-schema.ts`:

```jsonc
{
  "id": "seti-milestone-discovery-order",
  "game": "seti",              // key in config/eval-games.dev.json
  "edition": "base",
  "enabledContent": ["base"],  // content slugs
  "tier": "complex",           // simple = exactly 1 required item; complex = 2+
  "question": "In one turn I pass a gold milestone and a neutral milestone, and a species is discovered. What order do these resolve in?",
  "requiredEvidence": [
    { "key": "seti/milestones/between-turns", "phrase": "resolved between turns, after the current player has finished", "required": true },
    { "key": "seti/milestones/neutral-last", "phrase": "it is always resolved last", "required": true }
  ],
  "source": { "url": "https://boardgamegeek.com/thread/3632508", "title": "Non-Player Agency Markers" },
  "notes": "optional",
  "futureEvidence": []         // reserved for M6 errata/forum evidence; ignored
}
```

- **Evidence is matched by phrase, never by chunk id.** A chunk satisfies an item when it contains the phrase, ignoring case, curly quotes, dash variants and runs of whitespace. A single stray space is also allowed between two letters inside a word, which handles letter-spaced PDF text such as "L AUNCH A PROBE" without letting "now here" match "nowhere". If `heading` is set, the chunk's heading path must also contain it.
- **Phrases are short anchors** (≤ 15 words). Real rulebook text otherwise stays out of the repo.
- **Required vs supporting.** `required: false` marks a supporting item. It is reported, but doesn't count toward pass/fail.
- **Questions are paraphrased.** Don't copy forum posts. Don't fetch BGG through its internal `api.geekdo.com` API; M6 forum search uses the official XML API with a token.

### Adding a case

1. Write the line in the game's JSONL file.
2. Run the verifier (below). It fails if a phrase is in no single chunk (for example, split across a chunk boundary), if the heading doesn't match, or if the phrase also occurs in another game.
3. Run the eval and check the case behaves as expected.

## Answer cases

The answer eval reuses the retrieval dataset and adds two things, both validated by `src/dataset/answer-case-schema.ts`.

**An `answer` block on a retrieval case** makes it an answerable case. Cases without the block stay retrieval-only.

```jsonc
"answer": {
  "certainty": "DEFINITIVE",            // DEFINITIVE | QUALIFIED (INCONCLUSIVE is rejected here)
  "authority": "OFFICIAL_RULES",        // optional
  "forbiddenClaims": ["you may draw two cards"],  // optional, up to 5
  "sourcesDisagree": false,             // optional
  "requiresPlayerChoice": false         // optional
}
```

- **`forbiddenClaims`** are short phrases (same 1-120 character, 15-word rule as evidence phrases) for the tempting wrong answer. The answer must not contain them. A not-in-rulebook case may carry one only if no true statement from another edition, expansion or variant could contain it, since a correct INCONCLUSIVE explanation may mention that other source.

**Answer-only cases** go in `datasets/answer-only/<game>.jsonl`. They have the same fields as a retrieval case, but no `requiredEvidence`, and `answer.certainty` must be `INCONCLUSIVE`.

- **Not-in-rulebook questions** must be plausible questions asked at the table whose answer is truly absent from every enabled source. Examples: app or online play, a house rule, another edition's component, a strategy question.
- Ids are unique across both sets, and a question text may appear only once per game.
- Each not-in-rulebook case lists in `notes` the terms searched across every chunk of its game. The verifier fails if one of its `forbiddenClaims` appears in a chunk of that game, since the case is then probably answerable.
- Errata cases set `authority: "OFFICIAL_ERRATA"` only when the Stonemaier FAQ alone states the ruling. Where Rulepop repeats the FAQ text, the applied authority depends on which passage the answer cites, so `authority` is left unset.

## Commands

The live commands read AWS settings from env. `scripts/dev-env.sh` exports them from the deployed ingestion stage runner (embedding region, model id, dimension, vector index ARN, and table names), so the eval queries exactly what the pipeline indexed. It also exports `API_BASE` from the `BgrDevStack` outputs. Use Node 22 (`nvm use`).

```bash
pnpm -C evals test                     # unit tests + the AWS-free regression subset (also part of pnpm test)

source evals/scripts/dev-env.sh        # once per shell, needs AWS credentials
pnpm -C evals eval:ingest              # create/reuse the eval games and ingest their sources; writes config/eval-games.dev.json
pnpm -C evals exec tsx scripts/verify-dataset.ts   # check evidence phrases and not-in-rulebook forbidden claims against the chunks
pnpm -C evals eval:retrieval --markdown            # full eval; JSON report in evals/reports/ (gitignored)
pnpm -C evals eval:retrieval --games seti          # one game
pnpm -C evals eval:retrieval --dimensions 512 --markdown   # local index at 512 dimensions
pnpm -C evals eval:retrieval --rerank --route --max-cost 1 --markdown   # paid: rerank and routing
pnpm -C evals eval:answer --max-cost 1 --markdown                       # paid: answer eval (see below)
```

### Comparing embedding settings

`--dimensions <256|512|1024>` leaves the deployed index alone. It reads the eval games' current chunks from dev, re-embeds them with Titan at that dimension into an exact in-memory index, and runs the same cases against it. The embedding text and metadata come from `@bgr/retrieval` (`embeddingText`, `chunkVectorMetadata`), the same functions the EMBED stage uses, so only the dimension differs. Compare `--dimensions 512` with `--dimensions 1024` rather than with the live run: the live index is approximate and its vectors were written at ingest time. Re-embedding about 270 chunks costs well under a cent.

### Reranking and routing

`--rerank [key]` reranks each case's candidates (`topK`, 15) with the reranker model (`key` must be an approved reranker in `packages/ai/models.config.json`; bare `--rerank` uses the catalog default, currently GPT-6 Luna). The **whole reordered list** is scored, so the top-3 and top-10 bars measure the reranker. Scoring uses the case's labelled tier, never the router's. `--route` also classifies every question and reports routing accuracy and a confusion table against the labelled tiers; it is reported, not gated.

Both flags call Bedrock and cost money, so **`--max-cost <usd>` is required** with either. The run prints the planned number of model calls first, counts the cost of every call (failed calls included) and stops issuing model calls once the cap is reached. Remaining cases are scored without rerank and the report is marked `cutShort`. Rerank failures fall back to retrieval-score order and are counted in `rerankFallbacks`. The report also records the models, prompt versions and total model cost. **Paid runs need the operator's OK.**

The full eval is a **local, on-demand command**. It has no CI job. CI minutes are tight (ADR-0009), and a dispatch job would also need AWS access through OIDC.

### Answer eval and model comparison

`eval:answer` runs the real answer pipeline in process: the same router, reranker and answerer wiring as the Lambda (`createAnswerRoles`, `createAnswerPipeline`), the live retriever and dev documents. It bypasses the API and the daily cap. Each answer is scored deterministically against the case's expectations (certainty, authority, required evidence among the applied ruling's citations, forbidden claims, no ruling on a not-in-rulebook case), with no LLM judge. The marks are `answerBars` in `config/eval.config.json`; the pipeline's run budget, request timeout and evidence limits are under `answer` there.

```bash
pnpm -C evals eval:answer --max-cost 1 --markdown                                  # catalog default answerer
pnpm -C evals eval:answer --answerer gpt-6-luna,<key> --max-cost 3 --markdown     # side by side
pnpm -C evals eval:answer --games seti --cases <id>,<id> --max-cost 0.2            # a subset
pnpm -C evals eval:answer --labelled-tier --max-cost 1 --markdown                  # no router: labelled tiers
```

- `--answerer <key[,key…]>` runs once per key. Every key must be approved for the answerer role in `packages/ai/models.config.json`. The override is for this run only and never changes the API's defaults. `--reranker <key>` overrides the reranker the same way.
- `--labelled-tier` gives each question its labelled tier instead of calling the router, which shows what routing costs in misroutes.
- **`--max-cost <usd>` is required.** Unknown or unapproved keys fail before any call. The run then prints `planned questions: N × M models; estimated cost ≈ $X (cap $Y)`. The estimate is rough: per question, a router call (300 input / 20 output tokens), a rerank (7,800 / 80) and an answer (5,600 / 900), priced from the catalog. The cap covers the whole comparison. Once it is reached the run stops, and the report is `cutShort` with verdict `incomplete`. An incomplete run is never shown as clearing the marks.
- A case whose pipeline run throws (a model or retrieval failure, a timeout) is an error row. It counts against every rate, and the run goes on.
- Each answerer's report goes to `reports/answer-<generatedAt>.json`. It records the model in every role, the prompt versions, the `--games` and `--cases` filters (the markdown header marks a filtered run as a **subset**), per-case scores, cost, $/question and p50/p95 latency. `--markdown` prints the comparison table and names the cheapest model whose verdict is `pass`, or "none: operator decides".

**Paid runs need the operator's OK.** With the current catalog defaults the estimate is about $0.002 per question, so about $0.20 for 100 cases per answerer. Check the printed estimate before the run starts.

### Model availability check

`pnpm -C evals models:check` makes one tiny structured call (a router-style tier question) to every model in the catalog, using each entry's own region and structured-output mode, and prints a table with latency, cost and any error plus the total cost. An entry is called with the first role it is approved for (router before reranker); an entry approved for no role is reported as failed and not called. It exits non-zero if any model fails. It costs a fraction of a cent, needs AWS credentials and **needs the operator's OK**.

### Eval games and sources

`config/eval-sources.json` lists each eval game's documents. Each document has a **distinct `sourceType`**, because a second document with the same type in the same content package would supersede the first. The ingest script checks this. Each source is one of:

- `s3Key`: a raw object already in the ingestion bucket;
- `url`;
- `local`: a file outside the repo, such as `~/bgr-eval-sources/…`, for official FAQ PDFs downloaded by hand. BGG blocks automated downloads.

`"skip": true` leaves a document out until it is available. The eval games are separate from the older dev games, so they get current chunking.

## Backfilling provenance

Documents ingested before provenance existed have none. The backfill proposes evidence for each CURRENT document without it, and writes only what the operator confirms.

```bash
source evals/scripts/dev-env.sh
pnpm -C evals provenance:backfill plan                                # writes evals/reports/provenance-plan.json ; the apply path is relative to evals/
# review every entry; set "confirmed": true on the ones you accept
pnpm -C evals provenance:backfill apply reports/provenance-plan.json
```

The proposal records the stored tier as the operator's declaration, the upload or source host, and nothing about removed comments (unknown for old documents). A document changed since the plan was written is skipped, and a second apply is a no-op. A page that may contain reader-comment text should be re-ingested instead of backfilled.

Re-running `plan` overwrites the plan file and discards any confirmations in it. Only CURRENT documents are planned, so a legacy document reinstated later is picked up by a later `plan` run.

## Regression subset

`src/run-eval.test.ts` runs the whole pipeline over an invented game ("Starfall", `fixtures/retrieval/`). It uses the real `VectorRulesRetriever`, an in-memory index and a deterministic hash embedder. It guards scoring and the retriever's filtering: superseded documents and disabled promos never come back. It does not measure embedding quality. It needs no AWS and no network, and it runs in about a second inside `pnpm test`.

`src/run-answer-eval.test.ts` does the same for the answer eval. It runs the real answer pipeline over Starfall (`fixtures/answer/`: answerable cases, including errata over rules and a forbidden claim, plus not-in-rulebook cases) with a fake Bedrock client. It checks per-case scoring, the cost cap, error rows and labelled-tier mode, at no cost.
