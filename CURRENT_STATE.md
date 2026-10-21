# Current State

_Last updated: 2026-09-16_

## Current milestone

**Milestone 2 — Document Ingestion** (not started).

Spec: `docs/milestones/M2-document-ingestion.md`.

## Completed work

- **Milestone 0 — Repository & Engineering Foundation.** Fully bootstrapped and deployed to AWS dev.
  - pnpm workspace at root; packages `apps/web`, `apps/api`, `packages/{domain,ai,retrieval,ingestion,persistence,shared}`, `infrastructure/cdk`, `evals`.
  - TypeScript strict everywhere, shared `tsconfig.base.json`, `.nvmrc = 22`, `packageManager: pnpm@10.34.5`.
  - ESLint 9 flat config + Prettier 3 + Vitest 2 wired into `pnpm lint / format:check / typecheck / test`.
  - `apps/api` `GET /health` handler returning `{status, commit, time}` with unit tests.
  - `apps/web` React + Vite skeleton, one Testing-Library test.
  - `packages/shared` structured JSON logger with unit tests.
  - `infrastructure/cdk`: `BgrGithubOidcStack` and `BgrDevStack` (Node 22 Lambda behind API Gateway HTTP API, private S3 site bucket, CloudFront distribution with OAC, dedicated CloudWatch log group). CDK unit tests.
  - GitHub Actions: `ci.yml`, `deploy-dev.yml`, `security.yml`, `dependabot.yml`.
  - Repository: `marcuslowhuiyu/board-game-rules-rag` (private). CI green, Deploy dev green.
  - AWS: region `ap-southeast-1` (account id deliberately not recorded in the repo; `aws sts get-caller-identity`).
  - GitHub Environment `dev` created; `AWS_DEPLOY_ROLE_ARN` secret set to the `bgr-github-deploy-dev` role ARN.

- **Milestone 1 — Domain Model, Game Catalog & Sessions.** Complete. Merged to `main` as commit `6b50738` (PR [#6](https://github.com/marcuslowhuiyu/board-game-rules-rag/pull/6)); `Deploy dev` run `35078588409` succeeded end-to-end; the deployed dev environment passed every M1 acceptance check.

  - **`packages/domain`**: Zod-backed schemas and branded id types for `Game`, `Edition`, `ContentPackage`, `SourceDocumentMetadata`, `Session`, `Message`. `configurationFingerprint(gameId, editionId, enabledContentIds)` returns a SHA-256 hex over the canonical `(g, e, sorted-unique-c)` triple; a `fast-check` property test confirms fingerprint invariance under reordering.
  - **`packages/persistence`**: `GamesRepository`, `SessionsRepository`, `MessagesRepository` interfaces plus DynamoDB implementations (`@aws-sdk/lib-dynamodb`) and in-memory implementations for tests. `Clock` and `IdGenerator` seams.
  - **`apps/api`**: single `apps/api/src/handlers/api.ts` Lambda handler with a small path-template router covering `GET /health`, `GET/POST /games`, `GET /games/{id}`, `GET /games/{id}/content`, `POST /sessions`, `GET /sessions/{id}`, `DELETE /sessions/{id}`. Zod validation at every write endpoint; correlation-id-tagged structured logs; the session cookie is `HttpOnly; Secure; SameSite=Lax` (first-party — see ADR-0007); `DELETE` returns an expired cookie. `POST /sessions` rejects any `enabledContentId` that does not belong to the selected edition or whose status is not `READY`.
  - **`apps/web`**: three mobile-first screens (Game Search / Add Game / Game Configuration) with local `useState` navigation, calling the API through a typed client at `apps/web/src/api/client.ts`. The client defaults its base URL to `/api` (same-origin via CloudFront) and uses `credentials: 'same-origin'`. Styling is vanilla CSS in `apps/web/src/styles.css` (CSS variables, mobile-first widths, safe-area padding). No state library.
  - **CDK — `BgrDevStack`**: four on-demand DynamoDB tables (`games`, `content`, `sessions` with TTL attribute `ttl`, `messages`); the API Lambda receives least-privilege `readWriteData` grants on each table. A single **CloudFront distribution** serves both the SPA (default behavior → S3) and the API (`/api/*` behavior → API Gateway HTTP API origin with a viewer-request **CloudFront Function** that strips the `/api` prefix). API Gateway carries **no CORS configuration**; every browser request is same-origin. CDK unit tests cover the Node 22 runtime, the four tables and their TTL, the `/api/*` behavior with the prefix-strip Function, and the stack outputs.
  - **Deploy workflow**: builds the web bundle same-origin (`/api` default, no `VITE_API_URL`), idempotently seeds Twilight Imperium 4 plus `Prophecy of Kings` (EXPANSION) and `Codex Vol 1` (PROMO), exercises the full session-creation flow with both packages enabled, and verifies same-origin routing via `<cloudfront>/api/health`.

  **Live endpoints (dev):**
  - API (direct): `https://81wk8wat3m.execute-api.ap-southeast-1.amazonaws.com`
  - API (same-origin): `https://d1wbjv971ead09.cloudfront.net/api`
  - Web app: `https://d1wbjv971ead09.cloudfront.net/`
  - Seeded demo content in dev: `Twilight Imperium 4` / `4th Edition` with `Prophecy of Kings` (EXPANSION, id `c_pok`) and `Codex Vol 1` (PROMO, id `c_codex_vol1`).

  **Post-merge acceptance results (all green, 2026-09-16):**
  - `Deploy dev` run 35078588409 → success.
  - `GET /health` returns commit `6b50738…`, matching the merge commit.
  - `GET <cloudfront>/api/health` also returns the same commit — same-origin routing live.
  - Frontend `GET <cloudfront>/` returns the SPA HTML with the built asset bundle.
  - `GET /games?q=twilight` returns the seeded game with its edition embedded.
  - `GET /games/{id}/content` returns both the EXPANSION and the PROMO under the seeded edition, both `status: READY`.
  - `POST <cloudfront>/api/sessions` with both content ids enabled returns a session whose `enabledContentIds` round-trip; `GET /api/sessions/{id}` returns the same record; the browser is issued a `bgr_session` cookie carrying `HttpOnly; Secure; SameSite=Lax; Max-Age=86400` and the cookie is retained across requests.
  - `DynamoDB GetItem` on the sessions table shows `gameId`, `editionId`, `enabledContentIds`, `configurationFingerprint` (matches locally-recomputed SHA-256) and `ttl` set to 86376 seconds in the future (≈ 24 h, within the expected window).
  - `POST /sessions` with an unknown `enabledContentId` returns HTTP 400 with body `error.code = BAD_REQUEST`.

## Active decisions

Load-bearing decisions from `docs/adr/`:

- **ADR-0001** — TypeScript strict, Node 22 LTS, pnpm 10, CDK v2 TypeScript. Vitest / ESLint 9 / Prettier 3.
- **ADR-0002** — S3 Vectors initial vector store behind `RulesRetriever`.
- **ADR-0003** — `RulesModel` interface + Bedrock Converse adapter default.
- **ADR-0004** — DynamoDB full log + rolling summary + recent turns, 24h TTL.
- **ADR-0005** — Bounded `WebSearchProvider` loop with AgentCore adapter.
- **ADR-0006** — DynamoDB multi-table design for M1 entities (games, content, sessions, messages).
- **ADR-0007** — Same-origin routing via CloudFront `/api/*` + first-party `SameSite=Lax` session cookie; no API-side CORS.

M0-only implementation choices captured for future readers:

- CDK opts out of `exactOptionalPropertyTypes` (ADR-0001 Revisions).
- `BgrGithubOidcStack` imports the existing account-wide OIDC provider (the provider is a per-account IAM singleton).
- Trust policy uses `repo:<owner>/<repo>:*` **and** `repo:<owner>@<ownerId>/<repo>@<repoId>:*` — the second pattern is required because GitHub emits the immutable-id `sub` shape for this user/org.
- Deploy role currently holds `PowerUserAccess` + IAM passthrough as a starting point. Tightened per-service in Milestone 9.

M1-only implementation choices:

- **Slug uniqueness on games.** Enforced with a scan-based check inside `POST /games`. Fine at M1 catalog scale; upgrade path (name-prefix GSI or external index) noted in ADR-0006.
- **Catalog search.** `GET /games?q=` uses DynamoDB `Scan` + client-side case-insensitive `contains` over name and slug. Bounded by the catalog size; upgrade path in ADR-0006.
- **Frontend routing.** No `react-router`; a single `Screen` union in `App.tsx` drives navigation between the three screens. When the app grows a URL surface, revisit.
- **Frontend styling.** Plain CSS + CSS variables. No Tailwind / CSS-in-JS. Documented under G15 in `docs/CONTRADICTIONS_AND_GAPS.md`.
- **Content seeding.** `deploy-dev.yml` seeds two content packages via `aws dynamodb put-item` (bypasses the API on purpose — content authoring is not an M1 API surface). Deterministic ids (`c_pok`, `c_codex_vol1`) keep re-runs idempotent.

## Known issues / open questions

Full tracker: `docs/CONTRADICTIONS_AND_GAPS.md`.

- **G3 / G4 (S3 Vectors and AgentCore regional availability in `ap-southeast-1`).** Still not verified against the account — not blocking M2 (M2 is ingestion + parsing + chunking, no vectors yet). Verify before M3 / M6.
- **CSRF on state-changing endpoints.** M1 accepts the exposure (no user accounts, private beta blast radius). M4 will add a double-submit CSRF token before `POST /sessions/{id}/messages` ships. Recorded in ADR-0007 Consequences.
- **CloudFront edge latency on the API path.** Adding CloudFront in front of API Gateway costs a small amount of latency per API call; not measured yet. Revisit during M3 / M4 benchmarking (candidate: custom domain covering both hosts if latency becomes an issue).
- **CodeQL check is red on PRs.** GitHub's Code Scanning is not enabled for this private repo — same underlying gap as branch protection below. Both `Lint / Typecheck / Test / Synth` and `pnpm audit` pass; PRs merge as `MERGEABLE`.

## Requires operator decision, if you want them

- **Branch protection on `main`.** GitHub free tier does not allow classic branch protection or rulesets on private repositories. Two options:
  1. Upgrade the repo owner to GitHub Pro (or move to a paid org) and enable a ruleset requiring the "Lint / Typecheck / Test / Synth" check on `main`.
  2. Make the repo public.
  Until one of those happens, "main is protected" is honor-system only. Recorded in `docs/CONTRADICTIONS_AND_GAPS.md` under the resolved section with a caveat.
- **Code Scanning (CodeQL).** Same repo-visibility limitation as branch protection. Would be enabled by either option above.
- **`AWS_REGION` for a possible second region** for S3 Vectors or AgentCore — pending G3 / G4 verification.

## Next expected work

Milestone 2 — Document Ingestion. See `docs/milestones/M2-document-ingestion.md`.
