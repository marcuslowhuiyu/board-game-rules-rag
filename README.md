# Board Game Rules RAG

Mobile-friendly board-game rules referee. Source-aware retrieval, bounded generative reasoning, and explicit uncertainty.

Architecture decisions: [`docs/adr/`](./docs/adr). Contributor and agent workflow: [`CLAUDE.md`](./CLAUDE.md).

The planning docs (master plan, milestone specs, design docs, current state) live in a separate private repo, cloned locally as `planning/` and ignored here. Code comments that cite `MASTER_PLAN §N` refer to it.

## Repository layout

```
apps/web              React + Vite frontend
apps/api              Lambda handlers (currently GET /health)
packages/domain       Domain types and Zod schemas
packages/ai           Model interfaces + Bedrock adapters (empty at M0)
packages/retrieval    Retriever interface + S3 Vectors adapter (empty at M0)
packages/ingestion    Source ingestion pipeline (empty at M0)
packages/persistence  DynamoDB / S3 repositories (empty at M0)
packages/shared       Cross-cutting utilities (structured logger lives here)
infrastructure/cdk    AWS CDK v2 app (dev stack + GitHub OIDC stack)
evals                 Evaluation datasets, judges, and runners
docs                  ADRs, milestone specs, gap tracker
```

## Local prerequisites

- Node.js **22 LTS** (`nvm use` reads `.nvmrc`).
- pnpm **10** (`npm i -g pnpm@10`).
- For CDK synth/deploy: AWS CLI v2 configured (SSO or otherwise). CDK bootstrap must have been run once in the target account/region.

## Common commands

```bash
pnpm install
pnpm typecheck         # every package
pnpm lint              # ESLint (flat config)
pnpm format:check      # Prettier
pnpm test              # Vitest across all packages
pnpm -C apps/web dev   # frontend dev server
pnpm -C infrastructure/cdk synth  # verify CDK compiles
```

## Using the app

Run `pnpm -C apps/web dev`, then:

- **Rules Chat**: pick a game, configure it, and start a session. Ask a question and the applied ruling appears first, with its authority, certainty, confidence meter and source. When sources disagree, both rulings show side by side, and a question the rules don't settle shows no meter. "See sources" shows what each source tier says, with citations. A ruling the rules don't settle is shown as unsettled, not as a guess.
- **Settings**: open it from the header. It chooses the model for each role (router, reranker, answerer) from the approved list. Changes apply to new questions within about a minute. It has no auth in dev, which is an M10 launch blocker ([ADR-0014](./docs/adr/0014-runtime-model-settings.md)).

## Deployment

Automatic on merge to `main` via `.github/workflows/deploy-dev.yml`, which:

1. assumes the OIDC deployment role,
2. `cdk deploy`s `BgrDevStack` in `ap-southeast-1`,
3. smoke-tests `GET /health`,
4. builds the frontend, syncs it to S3, and invalidates CloudFront.

There are no long-lived AWS credentials in GitHub. See [`docs/adr/0001-runtime-stack.md`](./docs/adr/0001-runtime-stack.md) and the M0 milestone spec for setup details.

## First-time AWS bootstrap (one-time)

1. `cdk bootstrap aws://<account>/ap-southeast-1`
2. Deploy the OIDC stack once from a workstation with admin credentials:
   ```bash
   pnpm -C infrastructure/cdk deploy:oidc \
     -c githubRepo=<owner>/<repo> \
     [-c existingOidcProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com]
   ```
   The optional `existingOidcProviderArn` reuses an account-wide GitHub OIDC provider that already exists (the provider is a per-account singleton). Copy the `DeployRoleArn` output into the GitHub repository secret `AWS_DEPLOY_ROLE_ARN`.
3. Push to `main` — dev deploy runs automatically.
