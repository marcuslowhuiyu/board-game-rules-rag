# Milestone 9 — Production Hardening

**Master plan reference:** §48–§51, §54, §55, §69. **ADRs:** none new expected unless a hardening decision constrains future work. **Depends on:** M8.

## Objective

Ship a reliable private production deployment. Nothing new is promised to users; everything about the runtime becomes trustworthy — deploy path, budgets, alarms, backups, throttles, security posture.

## Deliverables

Environments and deploy path:

- New CDK `prod` stack, region-configured (default `ap-southeast-1`; secondary region for AgentCore if needed).
- Second OIDC deployment role for `prod`, trust policy restricted to the `prod` GitHub environment and (initially) a manual approval gate.
- `deploy-prod.yml` triggered by tags (e.g. `vX.Y.Z`) — no auto-deploy from `main` to prod.

Cost and throttling (`MASTER_PLAN.md` §51):

- AWS Budgets with alerts wired to a notification target (SNS → email/slack).
- Lambda reserved / provisioned concurrency where cold-start matters; concurrency caps as safety valves.
- API Gateway throttling per route.
- S3 lifecycle policies (raw/temporary/eval prefixes).
- CloudWatch log retention set per log group; nothing indefinite.
- Model token budgets enforced in code (from M4/M6); alarm on budget breaches.

Observability (`MASTER_PLAN.md` §50):

- Metric filters or EMF for the KPIs already emitted: request count, answer latency, retrieval latency, model latency, tokens, estimated AI cost, retrieval count, research frequency, INCONCLUSIVE rate, ingestion failures, cache hit rate.
- CloudWatch dashboard `prod-cost-and-quality` renders these.
- Alarms on error rate, p95 latency, ingestion failure rate, model 5xx rate, budget overrun.

Security (`MASTER_PLAN.md` §48):

- Full IAM review: least privilege per Lambda; no wildcards on production data buckets.
- S3 buckets private, encrypted at rest (SSE-KMS where warranted), Block Public Access on.
- Presigned upload constraints tightened for prod (max size, MIME, per-session quota).
- SSRF suite in CI verifying URL validation rejects private ranges and metadata endpoints.
- Prompt-injection regression suite: canonical adversarial rulebook fixtures added to `evals/security/`; nightly and on-PR runs assert the model does not follow embedded instructions.
- Dependency scanning (Dependabot alerts + npm audit gate) blocks high-severity in CI for prod-affecting packages.

Backup and recovery:

- DynamoDB point-in-time recovery enabled on prod tables.
- S3 raw/normalized buckets versioned with lifecycle to expire noncurrent versions after a documented window.
- Documented restore procedure in `docs/runbook.md`.

Operational runbook (`docs/runbook.md`):

- Incident response, deploy/rollback, cost overrun response, model-provider outage, S3 Vectors regional incident.

E2E smoke tests:

- Post-deploy suite exercises: create game → ingest small fixture rulebook → configure session → ask a definitive question → ask an INCONCLUSIVE question → verify metrics emitted.

## Explicitly out of scope

- User accounts, moderation, WAF, billing — all M10.
- Product feature changes.

## Verification

1. A tagged release deploys to prod through the approval gate, without any long-lived credentials.
2. E2E smoke tests pass against prod immediately after deploy.
3. All alarms verified by deliberately triggering safe test conditions in dev (or via chaos-style rehearsal in a scratch stack).
4. Cost dashboard shows correct numbers after a canned load run.
5. Runbook rehearsed at least once — a teammate can follow it cold.

## Definition of Done

`MASTER_PLAN.md` §71.
