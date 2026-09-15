# Milestone 4 — Rules Answering

**Master plan reference:** §7, §8, §11, §12, §23, §32, §33, §38, §44, §50, §64. **ADRs:** 0002, 0003. **Depends on:** M3.

## Objective

Combine retrieval with a bounded, deterministic generation step to produce cited rules answers. Introduce the `RulesModel` abstraction, the Bedrock Converse adapter, and the answer schema. Session memory is still single-turn here — multi-turn behaviour arrives in M5.

## Deliverables

Model layer in `packages/ai`:

- `RulesModel` interface exactly as in ADR-0003.
- Bedrock Converse adapter using the configured primary model (initially Nova 2 Lite — resolve the concrete Bedrock model id via config).
- Structured output via Converse where the model supports it; JSON-mode fallback otherwise. **Every response validated by a Zod schema in application code**, regardless of source.
- Telemetry hook records input/output tokens, latency, model id, correlation id per call.

Answer pipeline in `apps/api` (or a new `packages/answering`):

- The pipeline from `MASTER_PLAN.md` §23, minus the research/cache branches (those are M6):

  ```
  question → validate session → resolve config → retrieve → assess evidence →
    if sufficient: generate → validate citations → return
    if not:        return INCONCLUSIVE with retrieved evidence pointers
  ```

- `assessEvidence` uses `RulesModel.assessEvidence` to classify whether retrieved chunks are sufficient. Configurable evidence threshold.
- Generation prompt is versioned (string constant + version in code, or file with hash). Included in telemetry so eval reports can attribute regressions.
- Citation validator ensures every citation in the model output corresponds to a `chunkId` actually passed as evidence. Unknown citations fail validation and the response is downgraded to `INCONCLUSIVE` rather than returned to the user.

Response schema (`MASTER_PLAN.md` §8, §12):

```ts
{
  certainty: 'DEFINITIVE' | 'QUALIFIED' | 'INCONCLUSIVE';
  authority:
    | 'OFFICIAL_RULES' | 'OFFICIAL_ERRATA' | 'DESIGNER_OR_PUBLISHER'
    | 'COMMUNITY_CONSENSUS' | 'COMMUNITY_DISCUSSION' | 'UNKNOWN';
  answer: string;
  explanation: string;
  evidence: { chunkId: string }[];
  needsResearch: boolean;
}
```

The frontend generates the display representation (badges, expandable sections) from this validated structure.

API:

- `POST /sessions/{sessionId}/messages` — accepts user question; returns validated answer object plus resolved citation details (page, heading path, source title) fetched from `packages/persistence`.

Frontend:

- Rules Chat screen (`MASTER_PLAN.md` §44):
  - Answer, authority badge, certainty badge, citations, expandable explanation.
  - INCONCLUSIVE renders as a clear "no defensible ruling" state, not as a warning tacked onto a guess.

Evaluation:

- Expand the golden dataset toward ~75–100 cases. Add cases that must return `INCONCLUSIVE` (`MASTER_PLAN.md` §35).
- `evals/run-model-eval.ts` runs answer evaluation with deterministic assertions:
  - Correct `authority` and `certainty`.
  - Required evidence chunk id present.
  - `forbiddenClaims` substring / semantic checks fail loudly if triggered.
- Full model eval runs nightly and on demand; a fast smoke subset runs on PRs touching answering code.

## Explicitly out of scope

- Multi-turn conversation memory (M5).
- Web research and ruling cache (M6).
- LLM-as-judge scoring (M7).

## Verification

1. A configured game with an ingested rulebook can be asked a direct-lookup question and returns a cited, `OFFICIAL_RULES / DEFINITIVE` answer.
2. A question with deliberately absent evidence returns `INCONCLUSIVE` and does not fabricate a citation.
3. Citation validator: a manually corrupted response that claims a nonexistent chunk id causes the pipeline to downgrade to `INCONCLUSIVE`.
4. Telemetry emits token and latency data per request; visible in CloudWatch logs and included in the eval report.
5. Nightly full eval report shows baseline correctness, authority accuracy, citation faithfulness, and INCONCLUSIVE precision.

## Definition of Done

`MASTER_PLAN.md` §71. Includes updated evaluation cases and a recorded baseline eval report.
