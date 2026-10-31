# ADR-0013: Answer evaluation

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Marcus Low, Claude Code
- **Related:** ADR-0003, ADR-0011, ADR-0012, Milestone 4 (answer eval, step 4), MASTER_PLAN §11, §21

## Context

ADR-0012 fixed how an answer is built and validated, and left open which model should write it. Retrieval has its own eval and bars (ADR-0011), but nothing yet measures what a player sees: whether the ruling cites the right passages, whether it is as certain as the evidence allows, and above all whether it refuses to guess when the rulebook is silent. The answerer is the most expensive call per question, so the choice should be the cheapest model that clears marks set in advance, measured on the same code path the API runs.

## Decision

- **Case format.** An optional `answer` block on a retrieval case makes it an answerable case; cases without it stay retrieval-only. The block holds the expected `certainty` (`DEFINITIVE` or `QUALIFIED`), and optionally the expected `authority`, `sourcesDisagree`, `requiresPlayerChoice` and up to five `forbiddenClaims`. Not-in-rulebook cases live in `datasets/answer-only/<game>.jsonl`, have no required evidence, and must expect `INCONCLUSIVE`. Ids are unique across both sets and a question may appear once per game. A verifier fails a not-in-rulebook case if one of its forbidden claims appears in any chunk of its game, since the case is then probably answerable.
- **Checks are deterministic. There is no LLM judge until M7.** Each run is scored on certainty, authority, required evidence, forbidden claims and (for not-in-rulebook cases) whether the model guessed. A judge would add a second model's errors and cost to a comparison whose purpose is choosing a model, and would make the marks hard to reproduce. The answerable cases check only that the right passages are cited, not the ruling's wording (see known limits); judging wording is the M7 judge's job. Required evidence counts only the applied ruling's own citations, not panels and not passages that were sent but not cited.
- **Pass marks** (`answerBars` in `evals/config/eval.config.json`): zero guesses, at least 85 % right passages, at least 75 % right certainty. These are starting marks, to be revisited with the operator after the first run. A guess is a `DEFINITIVE` or `QUALIFIED` ruling on a not-in-rulebook case; it is zero tolerance because a fabricated ruling is the failure that matters most.
- **Denominators and the error rule.** The right-passages rate is over answerable cases and the right-certainty rate over all cases. A case whose pipeline run throws is an error row. It counts against every rate and the run goes on. Errored cases are excluded from the misroute buckets, because their routed tier is unknown; they stay in the evidence and certainty denominators and are listed separately, so the misroute rate can be slightly optimistic when a case was routed and then failed. The complex-as-simple evidence rate uses the complex cases routed simple. A run stopped by `--max-cost` is `cutShort` with verdict `incomplete`, never `pass`. Calibration (right rate per confidence level, and whether it falls with confidence) and the authority rate are reported, not gated.
- **Forbidden-claim rules.** A claim is found when its normalized text is a substring of the applied answer, the explanation or any panel answer. This is the simplest deterministic rule, and its cost is that a correct answer quoting the claim would false-hit. So claims are worded as the wrong assertion itself, such that a correct answer, including its negation ("no, X is not allowed"), cannot contain them. A not-in-rulebook case carries a claim only when no true statement from another edition, expansion or variant could contain it, because a correct `INCONCLUSIVE` explanation may mention that source and the explanation is scored too.
- **The eval bypasses the API and the daily cap.** `eval:answer` runs the pipeline in process with local AWS credentials, the live retriever and dev documents, an uncapped in-memory spend ledger and an infinite daily cap. Spend is capped instead by a required `--max-cost`: the run prints the planned questions and an estimated cost first, meters every model call (failed calls included, also when a run then throws), and stops issuing questions once the cap is reached. One cap covers a whole multi-model comparison, so later models can come out `incomplete`. Paid runs need the operator's OK.
- **One shared wiring.** `createAnswerRoles` (router, reranker and answerer on one model whose calls reach the running pipeline's collector and deadline) and `createSourceLookup` (document lookup, dropping chunks whose document is missing) live in `@bgr/answering` and are used by both the Lambda and the eval, so the eval measures what the Lambda runs. The eval can override catalog keys per role for one run only; an unapproved key fails before any call and never changes the API defaults.
- **Labelled-tier mode.** `--labelled-tier` gives each question its labelled tier instead of calling the router, at no cost. Comparing it with a routed run shows what router misroutes cost in answer quality. The tier is looked up by question text, which is unique per game; a duplicate across games could attribute a wrong tier to one case, which is judged implausible.
- **Choosing rule.** The cheapest model whose verdict is `pass` becomes the default answerer. If none passes, the report says "none: operator decides". Each report records the model in every role, prompt versions, filters (a filtered run is marked a subset), per-case scores, cost, cost per question and p50/p95 latency.

## Alternatives considered

- **An LLM judge now.** Rejected until M7: extra cost and variance, and the main risks (guessing, wrong citations, wrong certainty) are checkable by code.
- **Score wording against a reference answer.** Rejected: brittle string matching, and the cited passages already show whether the ruling rests on the right text.
- **Run through the deployed API.** Rejected: the daily cap and rate limit would stop a comparison, and results would depend on the API's own state.
- **A separate eval wiring of the roles.** Rejected: it could drift from the Lambda, and the measured model would no longer be the shipped one.

## Consequences

- **Positive:** the answerer choice is a measured, repeatable decision with marks fixed beforehand. A guess on a not-in-rulebook question fails the model regardless of its other scores. Spend is bounded and visible before it happens.
- **Negative and known limits:**
  - **All eval sources are OFFICIAL tier.** Cross-tier disagreement, `disagreesWithApplied` and the player-choice path are not measured live; they stay covered by unit tests only.
  - **The comparison candidates use `global.` inference profiles**, so questions and passages may leave APAC during the comparison (ADR-0011).
  - **Some prices are unverified** until the AWS bill is checked, so estimates and the cheapest-model ranking rest on catalog prices.
  - **The answerable cases check only that the right passages are cited**, not the ruling's wording. A ruling can cite the right passage and still misstate it; only the forbidden claims catch the tempting wrong answers.
  - The misroute rate is slightly optimistic when cases error after routing.
  - The marks are a first guess and may move after the first run.
- **Follow-up:** revisit the marks with the operator after the first run; add a judge at M7; add non-OFFICIAL sources to the eval so disagreement is measured.
