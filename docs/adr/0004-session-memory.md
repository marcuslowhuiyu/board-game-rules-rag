# ADR-0004: Session memory — full log in DynamoDB, rolling summary + recent turns in prompts

- **Status:** Accepted
- **Date:** 2026-09-15
- **Related:** `MASTER_PLAN.md` §29, §30, §45; Milestone 1, Milestone 5

## Context

Board-game sessions can be long (hours) and mid-play conversations reference earlier turns ("does that ability still apply?"). Naively concatenating every prior message into every prompt causes prompt bloat, cost growth, and correctness drift as unrelated turns compete for the model's attention. The complete conversation must still be recoverable for evaluation, telemetry, and user experience (scrollback).

## Decision

- **Persistence:** every user and assistant message is stored in DynamoDB, keyed by `sessionId`, sorted by monotonic message index. Full raw content is retained for the life of the session.
- **Prompt assembly:**
  - **Short sessions** (below a configured token budget for conversation): include the full conversation.
  - **Longer sessions:** inject a **rolling summary** produced by `RulesModel.summarizeSession` plus the **last N turns** verbatim (N configurable, default derived from token budget in `MASTER_PLAN.md` §30).
  - The current question and retrieved evidence are always separate prompt sections, not concatenated into "memory".
- **Session lifetime:** anonymous session with cryptographically random id; TTL of 24 hours after last activity, refreshed on activity. DynamoDB TTL attribute drives expiration.
- **Session identity:** `sessionId` transported via HttpOnly, Secure, SameSite cookie set by the API. Users may explicitly start a new session, which invalidates the previous cookie.
- **Telemetry:** `sessionContextTokens`, `inputTokens`, `outputTokens`, `retrievedTokens` recorded per turn.

## Alternatives considered

- **Always full conversation in the prompt.** Rejected: violates §30's context budget and grows cost linearly with session length.
- **Vector-based long-term memory over past turns.** Rejected initially: adds infrastructure without evidence it beats a rolling summary for a bounded 24-hour anonymous session.
- **JWT-encoded session state in the cookie.** Rejected: forces conversation retrieval on the client or bloats the cookie; conflicts with server-side full-history requirement.

## Consequences

- **Positive:** prompt size stays bounded; full history is always available for the UI, telemetry, and evaluation replay.
- **Negative:** summarization is an additional model call (cost + latency). Trigger threshold and summary quality are tuning parameters that need evaluation cases (Milestone 5).
- **Follow-up:** Milestone 5 adds multi-turn eval cases and measures summary drift. If summaries degrade correctness, revisit thresholds or summary prompts (new ADR only if the strategy itself changes).
