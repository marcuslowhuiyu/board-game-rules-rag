# Current State

_Last updated: 2026-09-15_

## Current milestone

**Milestone 1 — Domain Model, Game Catalog & Sessions** (not started).

Spec: `docs/milestones/M1-domain-model.md`.

## Completed work

- **Milestone 0 — Repository & Engineering Foundation.** Fully bootstrapped and deployed to AWS dev.
  - pnpm workspace at root; packages `apps/web`, `apps/api`, `packages/{domain,ai,retrieval,ingestion,persistence,shared}`, `infrastructure/cdk`, `evals`.
  - TypeScript strict everywhere, shared `tsconfig.base.json`, `.nvmrc = 22`, `packageManager: pnpm@10.34.5`.
  - ESLint 9 flat config + Prettier 3 + Vitest 2 wired into `pnpm lint / format:check / typecheck / test`.
  - `apps/api` `GET /health` handler returning `{status, commit, time}` with unit tests.
  - `apps/web` React + Vite skeleton, one Testing-Library test.
  - `packages/shared` structured JSON logger with unit tests.
  - `infrastructure/cdk`: `BgrGithubOidcStack` (deploy role + optional import of existing OIDC provider, trust supports GitHub's immutable-id `sub` shape) and `BgrDevStack` (Node 22 Lambda behind API Gateway HTTP API, private S3 site bucket, CloudFront distribution with OAC, dedicated CloudWatch log group). 8 CDK unit tests.
  - GitHub Actions: `ci.yml`, `deploy-dev.yml`, `security.yml`, `dependabot.yml`.
  - Repository: `marcuslowhuiyu/board-game-rules-rag` (private). Pushed. CI green, Deploy dev green.
  - Live endpoints:
    - API: `https://81wk8wat3m.execute-api.ap-southeast-1.amazonaws.com/health` → `{"status":"ok",...}`
    - Web: `https://d1wbjv971ead09.cloudfront.net/`
  - AWS: account `<AWS_ACCOUNT_ID>`, region `ap-southeast-1`. CDK was already bootstrapped (BootstrapVersion 32).
  - GitHub Environment `dev` created; `AWS_DEPLOY_ROLE_ARN` secret set to `arn:aws:iam::<AWS_ACCOUNT_ID>:role/bgr-github-deploy-dev`.

## Active decisions

Load-bearing decisions from `docs/adr/`:

- **ADR-0001** — TypeScript strict, Node 22 LTS, pnpm 10, CDK v2 TypeScript. Vitest / ESLint 9 / Prettier 3.
- **ADR-0002** — S3 Vectors initial vector store behind `RulesRetriever`.
- **ADR-0003** — `RulesModel` interface + Bedrock Converse adapter default.
- **ADR-0004** — DynamoDB full log + rolling summary + recent turns, 24h TTL.
- **ADR-0005** — Bounded `WebSearchProvider` loop with AgentCore adapter.

M0-only implementation choices captured for future readers:

- CDK opts out of `exactOptionalPropertyTypes` (ADR-0001 Revisions).
- `BgrGithubOidcStack` imports the existing account-wide OIDC provider (the provider is a per-account IAM singleton).
- Trust policy uses `repo:<owner>/<repo>:*` **and** `repo:<owner>@<ownerId>/<repo>@<repoId>:*` — the second pattern is required because GitHub emits the immutable-id `sub` shape for this user/org.
- Deploy role currently holds `PowerUserAccess` + IAM passthrough as a starting point. Tightened per-service in Milestone 9.

## Known issues / open questions

Full tracker: `docs/CONTRADICTIONS_AND_GAPS.md`.

- **G3 / G4 (S3 Vectors and AgentCore regional availability in `ap-southeast-1`).** Still not verified against the account — not blocking M1 (no vector store or web research yet). Verify before M3 / M6.
- **G7, G13, G14** (DynamoDB single-table vs multi, cookie/CORS cross-origin, contentId ↔ slug mapping) are due in M1.

## Requires operator decision, if you want them

- **Branch protection on `main`.** GitHub free tier does not allow classic branch protection or rulesets on private repositories. Two options:
  1. Upgrade the repo owner to GitHub Pro (or move to a paid org) and enable a ruleset requiring the "Lint / Typecheck / Test / Synth" check on `main`.
  2. Make the repo public.
  Until one of those happens, "main is protected" is honor-system only. Recorded in `docs/CONTRADICTIONS_AND_GAPS.md` under the resolved section with a caveat.
- **`AWS_REGION` for a possible second region** for S3 Vectors or AgentCore — pending G3 / G4 verification.

## Next expected work

Milestone 1 — Domain Model, Game Catalog & Sessions. See `docs/milestones/M1-domain-model.md`.
