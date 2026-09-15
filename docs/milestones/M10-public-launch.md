# Milestone 10 — Public-Launch Readiness

**Master plan reference:** §49, §70. **Depends on:** M9 and validated private-beta usage.

## Objective

Prepare the system for use by people outside the private beta. **Do not start this milestone until private usage validates the product.** Everything here is a re-evaluation of assumptions the private product made, not a pure extension.

## Deliverables (open scope — each item likely spawns its own ADR)

Identity and access:

- Authentication choice (Cognito user pools, Cognito with social providers, or an alternative) — decide with an ADR.
- User accounts model; migration path for anonymous sessions.
- Upload ownership — every ingested source has a responsible account.

Content governance:

- Game moderation workflow: duplicate-game detection, merge/dispute UI, admin review queue.
- Publisher copyright considerations: takedown workflow, upload attestations, per-source visibility (private vs shareable).
- Terms of service and privacy policy — legal review required.

Abuse and rate:

- Per-user rate limits (session creates, questions per hour, ingestions per day).
- Quotas on storage, embedding count, research budget.
- WAF in front of CloudFront and API Gateway.
- Malicious upload scanning (e.g. GuardDuty Malware Protection for S3 or an equivalent scanner in the ingestion pipeline before parse).
- Abuse-reporting mechanism from the answer UI and the game page.

Billing and scaling:

- If monetized: subscription plumbing, entitlements, and metering (not scoped here; separate program).
- Capacity plan: which AWS limits need increases at expected launch scale, and how autoscale behaves.

Operations:

- Public support process: intake channel, SLA targets, on-call rotation.
- Status page.
- Larger cost dashboards and per-tier reporting.

Re-evaluation:

- Every "acceptable for private beta" assumption reviewed: upload size, per-session limits, session TTL, evidence bar, research budget defaults, INCONCLUSIVE messaging.

## Explicitly out of scope

- Anything that turns out to belong in a later, business-driven milestone (marketing, growth analytics, referral systems).

## Verification

- Public launch checklist (grown out of this milestone) fully green.
- Security review sign-off.
- Legal sign-off on ToS/privacy.
- Load test against production-like environment at the target launch scale.
- Runbook and support process rehearsed against the on-call rotation.

## Definition of Done

`MASTER_PLAN.md` §71 plus the explicit launch checklist produced during this milestone.
