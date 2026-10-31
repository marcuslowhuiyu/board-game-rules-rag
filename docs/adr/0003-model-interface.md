# ADR-0003: Model interface — `RulesModel` abstraction over Bedrock Converse

- **Status:** Accepted
- **Date:** 2026-09-15
- **Related:** `MASTER_PLAN.md` §11, §12, §32, §33, §41; Milestone 4, Milestone 7

## Context

Model selection is an evaluation question, not an architectural commitment. The initial generator (Nova 2 Lite) will be benchmarked against alternatives in Milestone 7 and may change. If the application imports Bedrock SDKs or model IDs directly from business logic, model swaps become sprawling refactors — the exact failure mode §11 forbids.

## Decision

- All AI operations go through interfaces in `packages/ai`:
  ```ts
  interface RulesModel {
    answerRulesQuestion(input: RulesQuestionInput): Promise<RulesAnswer>;
    summarizeSession(input: SessionSummaryInput): Promise<SessionSummary>;
    assessEvidence(input: EvidenceInput): Promise<EvidenceAssessment>;
  }
  ```
- The default adapter uses **Amazon Bedrock Converse** and lives in `packages/ai/src/bedrock/`.
- **Model IDs, region, temperature, max tokens** are configuration (`models.primary.model`, etc.), never inline constants. Config is validated at boot with a Zod (or equivalent) schema.
- **Structured outputs** use Bedrock structured output where the selected model supports it. The application **re-validates** the parsed response against a Zod schema before use — every time, regardless of the model's claim.
- **Telemetry** captured on every call: input tokens, output tokens, latency, model id, correlation id. Emitted through the shared logger, not `console.log`.
- **No direct model calls from `apps/api`.** Handlers depend on the interface; the composition root wires in the Bedrock adapter.

## Alternatives considered

- **Direct Bedrock SDK calls from handlers.** Rejected: makes model swaps invasive and prevents mocking for evals and unit tests.
- **LangChain / Bedrock Agents as the orchestrator.** Rejected: the workflow (§23) is deterministic — a hand-written pipeline is smaller, testable, and doesn't hide token or cost behaviour.
- **Provider-agnostic multi-model gateway (LiteLLM etc.).** Rejected initially: Bedrock is the only provider we plan to use short-term; adding a gateway increases surface without adding value. Revisit if a non-Bedrock model becomes competitive in Milestone 7.

## Consequences

- **Positive:** model swaps are configuration + one adapter file. Judge models in Milestone 7 use the same interface with a different config profile. Unit tests can inject fake `RulesModel` implementations.
- **Negative:** two layers to keep in sync (interface + adapter). The Bedrock Converse structured-output feature is not uniformly supported across all Nova/Claude models — the adapter must have a JSON-mode + validation fallback and skip cleanly to it.
- **Follow-up:** the initial `RulesQuestionInput` / `RulesAnswer` / evidence types are defined in Milestone 4. The "Nova 2 Lite" model id in the plan is a plan-time name; the concrete Bedrock model id gets pinned in config during Milestone 4 (see `planning/CONTRADICTIONS_AND_GAPS.md`).

## Revision (2026-10-29)

ADR-0011 adds the model catalog (approved models per role and defaults in `packages/ai/models.config.json`) and the structured Converse adapter with the router and reranker roles. The separate `assessEvidence` operation above is expected to be replaced by a single answer call in the next step of Milestone 4; that change will be recorded when it lands. The decisions above otherwise stand.

## Revision (2026-10-31)

ADR-0012 lands that change: the separate `assessEvidence` operation is replaced by the single answer call (`RulesAnswerer`, prompt `answerer-v1`), whose output is validated in code. The decisions above otherwise stand.
