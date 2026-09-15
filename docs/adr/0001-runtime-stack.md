# ADR-0001: Runtime stack — TypeScript, Node.js, pnpm workspaces, AWS CDK

- **Status:** Accepted
- **Date:** 2026-09-15
- **Related:** `MASTER_PLAN.md` §53, §56, §57; Milestone 0

## Context

The project needs one language and one build/deploy toolchain across frontend, backend Lambdas, shared libraries, and infrastructure. Splitting languages (e.g. Python Lambdas + TypeScript frontend) doubles the tooling surface and prevents sharing domain types across the API boundary — a problem for a system whose correctness depends on structured, validated shapes flowing from model → API → UI.

## Decision

- **Language:** TypeScript with `strict: true` everywhere (frontend, Lambdas, CDK, evals).
- **Runtime:** Node.js on AWS Lambda. The specific Node LTS version is chosen in Milestone 0 (currently the latest AWS-supported LTS) and pinned via `engines` in each `package.json` and via `.nvmrc`.
- **Package manager / workspace:** pnpm workspaces. No Nx / Turborepo / Lerna unless a later ADR proves a concrete benefit.
- **Infrastructure as Code:** AWS CDK v2 in TypeScript. All deployable infrastructure is expressed in CDK.
- **Testing / linting / formatting:** Vitest for unit and integration tests, ESLint for lint, Prettier for formatting. These are recommended defaults; Milestone 0 confirms and amends this ADR if any is replaced.

## Alternatives considered

- **Python for the backend / ingestion.** Rejected: forces two languages, breaks type sharing across the API boundary, and adds a second CI matrix. Rules ingestion is text-heavy but does not need Python-only libraries.
- **Nx / Turborepo.** Rejected initially: pnpm workspaces cover build orchestration for the small graph we start with. Revisit if incremental builds or remote caching become a real bottleneck.
- **Serverless Framework / SAM.** Rejected: CDK gives full TypeScript, first-class construct composition, and avoids a second config language (YAML) for infra.

## Consequences

- **Positive:** one language across the whole stack; shared domain types; strict typing pushes structured-output validation into the type system.
- **Negative:** Node.js cold starts on Lambda need attention (bundle size, tree-shaking, `esbuild`) later in Milestone 4+. CDK synth is slow on large trees; not an issue at this scale.
- **Follow-up:** Milestone 0 must pin the Node LTS version and record it here (append a "Revision" line rather than editing the Decision). Bundler choice for Lambda (esbuild via CDK `NodejsFunction` is expected default) is a Milestone 0 implementation detail, not an ADR-worthy decision unless changed later.

## Revisions

### 2026-09-15 — Milestone 0 pins

- **Node.js:** 22 LTS (`.nvmrc` = `22`, `engines.node = ">=22.0.0"`). Matches AWS Lambda `nodejs22.x`, which the CDK `NodejsFunction` targets in `bundling.target = 'node22'`.
- **pnpm:** `10.34.5` (recorded in root `packageManager`).
- **TypeScript:** `^5.6.2`. Base config lives at `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes` all on. CDK opts out of `exactOptionalPropertyTypes` because `aws-cdk-lib`'s public types are not compatible with it — noted here so a future upgrade or ADR revision can revisit.
- **Testing / linting / formatting confirmed:** Vitest 2.x, ESLint 9 flat config with `typescript-eslint` 8, Prettier 3.
- **Bundler for Lambda:** esbuild (via CDK's `NodejsFunction`). Added `esbuild` as a root devDependency so `pnpm exec esbuild` resolves when CDK's `NodejsFunction` bundling runs from the workspace root.
