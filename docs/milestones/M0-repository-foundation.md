# Milestone 0 — Repository & Engineering Foundation

**Master plan reference:** §60. **ADRs:** 0001. **Depends on:** none.

## Objective

Stand up a production-quality project skeleton before any application features exist. When this milestone lands, every subsequent milestone plugs into a repo where lint, typecheck, tests, CDK synth, security scans, and OIDC-based dev deployment already work.

## Deliverables

Repository layout (`MASTER_PLAN.md` §57):

```
/apps/web        React + TypeScript + Vite skeleton
/apps/api        Lambda/API Gateway skeleton with GET /health
/packages/
  domain         empty package, tsconfig + build
  ai             empty package, tsconfig + build
  retrieval      empty package, tsconfig + build
  ingestion      empty package, tsconfig + build
  persistence    empty package, tsconfig + build
  shared         empty package, tsconfig + build
/infrastructure/cdk    CDK v2 app with dev stack: API Gateway HTTP API,
                       Lambda, S3 static site, CloudFront, CloudWatch
                       log group, IAM OIDC role for GitHub Actions
/evals           empty package + README
/.github/workflows
  ci.yml         install / format-check / lint / typecheck / test / cdk synth / security
  deploy-dev.yml on merge to main: assume OIDC role, cdk deploy dev, smoke test
  security.yml   Dependabot + CodeQL
```

Tooling:

- pnpm workspaces at the root.
- TypeScript `strict: true` in every package via a shared `tsconfig.base.json`.
- ESLint + Prettier + import ordering. Commit a shared config in `packages/shared` or `tools/`.
- Vitest configured in `apps/api`, `apps/web`, and one package as proof.
- `.nvmrc` and `engines` pinning the Node LTS version (record it in ADR-0001 as a "Revision" line).
- Dependabot config for npm + GitHub Actions.
- CodeQL workflow for the JS/TS ecosystem.

AWS bootstrap:

- One CDK stack for the **dev** environment in `ap-southeast-1`.
- `GET /health` Lambda returning `{ status: "ok", commit: <sha> }`.
- Static frontend built by Vite, uploaded to S3, fronted by CloudFront.
- CloudWatch log group per Lambda, structured JSON logger primitive in `packages/shared/logging`.
- One OIDC-federated IAM role that GitHub Actions assumes for the dev environment. Trust policy restricted by repo + branch (`main`) + environment name (`dev`).
- No IAM users or long-lived access keys created.

Docs:

- Update `CURRENT_STATE.md` to mark M0 complete and set current milestone to M1.
- Amend `docs/adr/0001-runtime-stack.md` with the pinned Node LTS version.
- README at repo root explaining local setup (`pnpm install`, `pnpm dev`, `pnpm test`) and the bootstrap prerequisites (`aws configure sso` or equivalent for local; nothing needed to trigger CI).

## Explicitly out of scope

- Any application code beyond `/health`.
- Any DynamoDB tables, S3 Vectors buckets, or Bedrock configuration.
- Production environment. Only `dev` in this milestone.
- Domain types, ingestion, or model adapters — those are M1+.

## Verification

1. `pnpm install && pnpm -r build && pnpm -r test` succeeds locally.
2. `pnpm -C infrastructure/cdk synth` succeeds.
3. Open a PR from a feature branch: `ci.yml` runs and passes on the PR.
4. Merge to `main`: `deploy-dev.yml` assumes the OIDC role, deploys the CDK dev stack, and the post-deploy smoke test hits the deployed `GET /health` successfully.
5. The deployed CloudFront URL serves the Vite-built frontend.
6. `aws iam list-access-keys` for the AWS account shows no keys created for GitHub Actions.
7. `docs/CONTRADICTIONS_AND_GAPS.md` items resolved by M0 (Node version, tooling choices, AWS region reality-check for S3 Vectors and AgentCore) are updated with the actual decisions.

## Definition of Done

See `MASTER_PLAN.md` §71. Every checkbox applies except "relevant evaluation cases added" (no rules logic yet).
