# Current State

_Last updated: 2026-09-15_

## Current milestone

**Milestone 1 — Domain Model, Game Catalog & Sessions** (not started).

Spec: `docs/milestones/M1-domain-model.md`.

## Completed work

- **Milestone 0 — Repository & Engineering Foundation.** Repository skeleton is live locally; CI/CD workflows and CDK app are ready for the first AWS bootstrap (see "Requires operator action" below).
  - pnpm workspace at root; packages `apps/web`, `apps/api`, `packages/{domain,ai,retrieval,ingestion,persistence,shared}`, `infrastructure/cdk`, `evals`.
  - TypeScript strict everywhere, shared `tsconfig.base.json`, `.nvmrc = 22`, `packageManager: pnpm@10.34.5`.
  - ESLint 9 flat config + Prettier 3 + Vitest 2, all wired into `pnpm lint`, `pnpm format:check`, `pnpm test`.
  - `apps/api` `GET /health` Lambda handler with unit tests.
  - `apps/web` React + Vite skeleton with one Testing-Library test.
  - `packages/shared` exports a `createLogger` structured JSON logger (used by the health handler) with unit tests.
  - `infrastructure/cdk`: `BgrGithubOidcStack` (OIDC provider + deploy role scoped to `owner/repo` context) and `BgrDevStack` (Node.js 22 Lambda behind API Gateway HTTP API, private S3 site bucket, CloudFront distribution with OAC, CloudWatch log group with 1-week retention). CDK unit tests over both stacks.
  - GitHub Actions: `ci.yml` (format / lint / typecheck / test / cdk synth), `deploy-dev.yml` (OIDC-assumed role → CDK deploy → smoke test `/health` → frontend build + S3 sync + CloudFront invalidation), `security.yml` (CodeQL + pnpm audit weekly and on PR).
  - Dependabot for npm + github-actions.
  - Root `README.md` with local setup, deploy workflow, and one-time AWS bootstrap instructions.
  - Documentation refresh: ADR-0001 now records the pinned Node/pnpm/TS/tooling versions; `docs/CONTRADICTIONS_AND_GAPS.md` moves G1/G2 to "Resolved".

## Active decisions

Load-bearing decisions from `docs/adr/`:

- **ADR-0001** — TypeScript strict, Node 22 LTS, pnpm 10 workspaces, CDK v2 TypeScript. Vitest / ESLint 9 / Prettier 3 confirmed.
- **ADR-0002** — S3 Vectors as the initial vector store, behind `RulesRetriever`.
- **ADR-0003** — `RulesModel` interface, Bedrock Converse adapter default, Nova 2 Lite initial generator.
- **ADR-0004** — DynamoDB full log + rolling summary + recent turns, 24h TTL.
- **ADR-0005** — Bounded loop over `WebSearchProvider`, AgentCore adapter.

M0-only implementation choices worth remembering:

- CDK opts out of `exactOptionalPropertyTypes` (see ADR-0001 Revisions) because `aws-cdk-lib`'s public types fight it.
- OIDC deployment role uses `PowerUserAccess` + IAM passthrough as a starting point. Tightened per-service in Milestone 9.
- The `AWS_DEPLOY_ROLE_ARN` GitHub secret must be populated with the `DeployRoleArn` output from `BgrGithubOidcStack` before `deploy-dev.yml` can run.

## Known issues / open questions

Full tracker: `docs/CONTRADICTIONS_AND_GAPS.md`.

- **G3 (S3 Vectors) and G4 (AgentCore) regional availability** in `ap-southeast-1` are still unverified — they need a real AWS account to check. They are not blockers for M1 (no vector store or web research yet), but must be resolved before Milestone 3 (retrieval) and Milestone 6 (research), respectively.
- **G7, G13, G14** all bite Milestone 1 (DynamoDB table design, cookie / CORS cross-origin choice, contentId ↔ slug mapping).

## Requires operator action (before `deploy-dev.yml` will succeed)

None of these are things Claude Code can do — they require your AWS account and repository:

1. `cdk bootstrap aws://<account>/ap-southeast-1` once, from a workstation with admin credentials.
2. `pnpm -C infrastructure/cdk deploy:oidc -c githubRepo=<owner>/<repo>`, then copy the `DeployRoleArn` output into the GitHub repository secret `AWS_DEPLOY_ROLE_ARN`.
3. Create a GitHub Environment named `dev` and protect it if desired.
4. Push a real `githubRepo` value into `infrastructure/cdk/cdk.json` (currently `REPLACE_ME/board-game-rules-rag`) or rely on the `-c githubRepo=` override in the workflows (which pass `${{ github.repository }}` automatically).

Once those are done, the first push to `main` runs `deploy-dev.yml` end-to-end.

## Next expected work

Milestone 1 — Domain Model, Game Catalog & Sessions. See `docs/milestones/M1-domain-model.md`.
