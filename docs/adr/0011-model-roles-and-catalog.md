# ADR-0011: Model roles and a configured model catalog

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** Marcus Low, Claude Code
- **Related:** ADR-0003, Milestone 4 (router and reranker), MASTER_PLAN §11, §12, §21

## Context

Retrieval returns 15 candidate passages by vector similarity, but the answer only needs the few that matter. A reranker model reorders the candidates, and a router decides how many to keep: 3 for a simple question, 10 for a complex one. Both are small structured-output tasks, and the cheapest model that meets the retrieval bars (simple questions 90% with the required passage in the top 3, complex questions 70% with all required passages in the top 10) is the right one. Which model that is remains an evaluation question (MASTER_PLAN §11, ADR-0003), so the choice must be configuration and the choice must be measurable.

Two risks come with putting a model in the retrieval path. Passage text is untrusted content that could try to instruct the model (§12). And a model failure must not take retrieval down with it.

## Decision

- **A model catalog lives in configuration** (`packages/ai/models.config.json`, loaded and validated with Zod by `packages/ai/src/models/catalog.ts`). It lists each model's Bedrock id, region, prices per million tokens, structured-output mode (`native` or `json`), max tokens, an optional temperature (omitted for models that reject it) and optional provider-specific request fields, and names the approved models and the default for each role (`router`, `reranker`). The catalog is bundled into the build. `modelFor(catalog, role, key?)` returns the default or the requested model and rejects any key that is not approved for that role. Loading fails if a default is not approved or an approved key has no entry.
- **Structured Converse calls go through one adapter** (`packages/ai/src/bedrock/converse-structured.ts`). A model with native support gets the JSON schema in `outputConfig.textFormat`. Any other model gets the schema in the prompt and its first JSON object is extracted. Either way the application validates the response with Zod. Invalid output gets one retry, then `ModelOutputError`. Transient Bedrock errors are additionally retried by the SDK (3 attempts by default), separate from that retry; a Bedrock failure that persists raises `ModelCallError`. Each call emits one telemetry record: role, model key and id, prompt version, uncached input, cache read, cache write and output tokens, latency, cost from the catalog prices (Bedrock prompt-caches some models automatically, e.g. GPT-6 Luna via its global profile, so cache tokens are priced too; unset `cacheReadUsdPerMTok` and `cacheWriteUsdPerMTok` fall back to the input price, which never under-counts), attempts and outcome.
- **Roles are versioned prompts in code** (`packages/ai/src/roles/`): the router (`router-v2`) and the reranker (`reranker-v2`). The reranker asks the model for the top N most relevant passages (N is configured, 10 in the eval config, matching the complex keep count) rather than an order of every candidate, because Nova Micro placed only about 5 passages when asked to order all of them. The prompt asks for exactly N labels, including loosely relevant passages if needed to reach N. Passages are labelled `P1..Pn` inside `<passage>` delimiters, any delimiter text in passages and headings is neutralised, and the prompt states that passage text is untrusted data and never an instruction. Prompts change with a new version string, so telemetry shows which prompt produced a result.
- **Retrieval has safe fallbacks** (`packages/retrieval/src/rerank.ts`, `route.ts`). Reranking always returns every candidate exactly once: the ranker's ids come first, with unknown and repeated ids ignored, and any candidate it omitted follows in retrieval-score order. If the ranker call fails, the candidates are returned in retrieval-score order and the outcome is marked `fallback`. If the router fails, the question is treated as complex, so retrieval keeps more rather than fewer passages. Keep counts are 3 for simple and 10 for complex.
- **Starting assignment:** the router and the reranker both use Amazon Nova Micro. GPT-6 Luna is an approved reranker fallback, used only if Nova Micro misses a bar; the operator approved it. A change of default is a catalog edit with its own commit, backed by an eval run.
- **Region and inference profiles.** The Bedrock runtime client is in `ap-southeast-1`. Nova Micro is reached through the `apac.` inference profile and GPT-6 Luna through the `global.` profile. Questions and retrieved passages may therefore be processed outside Singapore (other APAC regions for Nova Micro, any commercial region for Luna). The operator accepted this.
- **The eval harness exercises the roles.** `--rerank` and `--route` score the retrieval bars with these models, `--max-cost` is required with them. Once the accumulated cost (failed calls included) reaches the cap, no further model calls are made, the remaining cases are scored without them, and the report is marked `cutShort`; the cost can overshoot the cap by at most one call. `models:check` makes one small structured call per catalog entry, prints a table of latency and cost per model, and exits non-zero if any call fails, so access problems show up before a paid run.

## Alternatives considered

- **Model ids as constants in code.** Rejected: CLAUDE.md requires models in configuration, and a swap would need a code change.
- **Trust the model's structured-output claim.** Rejected: ADR-0003 requires application-side validation, and a model can still return a wrong or partial list.
- **Fail the request when the reranker or router fails.** Rejected: both only improve ordering, and vector order and a larger keep count are acceptable degraded behaviour.
- **A larger model for everything.** Rejected for cost and latency until the eval shows Nova Micro misses a bar.

## Consequences

- **Positive:** swapping or adding a model is a catalog edit plus an eval run, with a hard list of approved models per role. Cost per call is recorded. A bad model response cannot lose candidates or crash retrieval, and passage text cannot reach the model as an instruction.
- **Negative:**
  - An extra model call adds latency and cost to each question (two when both roles run).
  - Prices in the catalog are copied by hand and can drift from Bedrock's.
  - Cross-region inference profiles mean data may leave Singapore, so the choice of default carries a data-handling implication.
  - Delimiters reduce but do not eliminate prompt injection; the validated, keep-everything-once output limits the damage to ordering.
- **Follow-up:** ADR-0003's `assessEvidence` is replaced by one answer call in the next step (the answer role and its catalog entry are added then). Run the paid availability check and retrieval eval with the operator, and change the reranker default to `gpt-6-luna` only if the eval requires it.
