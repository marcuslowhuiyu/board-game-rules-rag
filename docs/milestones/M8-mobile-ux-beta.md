# Milestone 8 — Mobile UX & Private Beta

**Master plan reference:** §44, §68. **ADRs:** none new expected. **Depends on:** M7.

## Objective

Make the app usable at a real table with real players. Fix the friction that only surfaces during live play, and collect signal for the M9 hardening pass and future eval cases.

## Deliverables

Mobile UX polish across the primary screens (`MASTER_PLAN.md` §44):

- Game Search: keyboard-friendly on mobile, instant filtering, recent games surfaced.
- Game Configuration: content checkboxes grouped by type (base / expansion / promo / module), sticky "Start Session" affordance.
- Rules Chat: large tap targets, one-hand ergonomics, answer visible without scrolling on typical phones, badges (authority/certainty) legible in bright light.
- Add Game / Ingestion Progress: clear stage feedback, resumable-feeling UX (long parses don't look stuck).
- Citation Viewer: readable rendering of source excerpt with page/heading reference; back-navigation clear.
- Uncertainty presentation: `INCONCLUSIVE` and `QUALIFIED` states are visually distinct from confident answers, not styled as warnings on a definitive answer.
- Retry/error states: never a dead-end; always a "try again" or "start new session" path.
- Feedback affordance: a "was this ruling correct?" button per answer, capturing question, answer, retrieval trace, model id, and latency (`MASTER_PLAN.md` §68).

Playtest program:

- At least two real-play sessions with the target friend group.
- Structured collection of feedback events into a `PlaytestFeedback` DynamoDB table (respect privacy — record what the user opts to send).
- Post-playtest triage: every ruling the group disagreed with becomes a regression eval case.

Backend adjustments as needed:

- Endpoints or fields that block a good mobile experience (e.g. missing citation excerpt text on the answer response) are added; larger changes documented against this milestone.

## Explicitly out of scope

- Public launch mechanics (M10).
- Production environment beyond dev (M9).
- Accounts, quotas, moderation (M10).

## Verification

1. Two playtests completed; regressions filed as eval cases in `evals/`.
2. Lighthouse mobile performance and accessibility scores recorded as a baseline in `CURRENT_STATE.md`.
3. Feedback events reach the `PlaytestFeedback` table and are exportable for later analysis.
4. Nightly eval still passes with the new regression cases (or failures are documented and scheduled).

## Definition of Done

`MASTER_PLAN.md` §71. Evaluation cases from playtest failures added.
