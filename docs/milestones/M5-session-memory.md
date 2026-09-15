# Milestone 5 — Session Conversation Memory

**Master plan reference:** §29, §30, §65. **ADRs:** 0004. **Depends on:** M4.

## Objective

Turn the single-turn Rules Chat into a natural multi-turn conversation without unbounded prompt growth, per ADR-0004.

## Deliverables

Persistence:

- Every user and assistant message is persisted in DynamoDB (already stored at write time in M1's `MessagesRepository`; extend fields as needed for role, timestamp, token counts).
- `Session` grows `conversationSummary` and `summaryVersion` fields; `updatedAt` refreshed on any activity, which extends TTL.

Prompt assembly in `packages/answering` (or wherever the M4 pipeline lives):

- Compute a running token count of the conversation.
- If total conversation tokens ≤ `sessionContextBudgetTokens` (config), include the full conversation in the prompt.
- Otherwise: include `conversationSummary` + last N messages verbatim where N is the largest that fits under the token budget. Both sides of the budget are configurable.
- The current question and retrieved evidence remain distinct prompt sections.

Summarization:

- `RulesModel.summarizeSession` invoked when the session crosses the budget or when a "summary is stale" heuristic fires (e.g. K messages since last summary).
- Summaries are game-aware: they preserve relevant configuration and previously established rulings, discard chit-chat.
- Summarization telemetry recorded (token counts, latency).

Session controls:

- `POST /sessions` supports "start a new session" from the UI, replacing the cookie.
- `DELETE /sessions/{sessionId}` clears server state.
- Session TTL still 24 hours, refreshed on activity. Configurable.

Frontend:

- Chat UI shows the full stored conversation (from DynamoDB), regardless of what was included in the last prompt.
- "New session" control that calls `POST /sessions` and clears the local view.

Evaluation:

- Add multi-turn eval cases (`MASTER_PLAN.md` §35): follow-up question resolves correctly against earlier turn; a corrective follow-up ("earlier you said X, but…") does not degrade the ruling if X was correct.
- A stress case: long synthetic conversation exceeding the budget; verify prompt size stays bounded and the ruling remains correct where possible.

Observability:

- Record `sessionContextTokens` per turn alongside existing telemetry.
- Include a per-session summary of prompt-size trajectory (visible in the eval report or a simple CloudWatch metric).

## Explicitly out of scope

- Web research and ruling cache (M6).
- Cross-session memory of any kind — deferred product-wide.

## Verification

1. A short session shows the whole conversation in the prompt (verified via telemetry / log dump on a debug flag in dev).
2. A long session crosses the budget: `conversationSummary` appears, prompt size flat-lines at the budgeted amount, correctness on the follow-up eval cases stays within tolerance of the M4 baseline.
3. Full conversation is always recoverable from DynamoDB via an internal admin endpoint or script.
4. Session TTL refresh works: sending a message pushes the TTL out by 24h.

## Definition of Done

`MASTER_PLAN.md` §71. Includes multi-turn eval cases and updated report showing prompt size discipline.
