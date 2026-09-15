# Claude Code Instructions

You are the primary implementation agent for the **Board Game Rules RAG** project.

## Read before every task, in order

1. `CURRENT_STATE.md` — where the project is right now, which milestone is active, and known issues.
2. `docs/milestones/<current-milestone>.md` — the spec for the milestone you are working on.
3. Any ADR under `docs/adr/` that the current milestone spec references.
4. Only the source files under `apps/`, `packages/`, `infrastructure/`, or `evals/` that are relevant to the change you are making.

**Do not read `MASTER_PLAN.md` in full unless the milestone spec tells you to.** It is the long-form product/architecture reference; the milestone spec and ADRs already extract what you need. Read specific sections of it on demand.

**Do not read `docs/CONTRADICTIONS_AND_GAPS.md`** unless the milestone spec references a decision that is listed there as unresolved.

## Rules of engagement

- Implement **only the current milestone**. Do not proactively pull in scope from future milestones. Stubs for future interfaces are allowed only when a milestone spec explicitly requires them.
- Work on a feature branch named `feature/m<NN>-<short-slug>` (e.g. `feature/m01-domain-model`). `main` is protected.
- Follow the workflow in `MASTER_PLAN.md` §59 (Claude Code Execution Rules): branch → read docs → implement → tests → quality checks → docs → update `CURRENT_STATE.md` → PR.
- Every milestone follows the Definition of Done in `MASTER_PLAN.md` §71.
- If a required decision is missing or the plan contradicts itself, **stop and consult `docs/CONTRADICTIONS_AND_GAPS.md`**. If the answer isn't there, escalate to the user and record the new decision as an ADR before proceeding.

## Architectural non-negotiables

These are load-bearing choices; violating them requires a new ADR, not an inline exception.

- **TypeScript strict mode** across the whole workspace.
- **Dependency inversion** around AWS services and model providers. Business logic never imports `@aws-sdk/*` or Bedrock model IDs directly — it goes through interfaces defined in `packages/domain` or `packages/ai`.
- **Model IDs, region, embedding dimensions, retrieval K, chunk size, research budgets** live in configuration, never in code.
- **Structured outputs are validated in application code** even when the model claims to produce them.
- **Retrieved content and web pages are untrusted data**, never system instructions.
- **No long-lived AWS credentials in GitHub.** All GitHub Actions AWS access uses OIDC federation.
- **No AWS console-created infrastructure** becomes required state. Everything runs through CDK.

## Prioritization when values conflict

`MASTER_PLAN.md` §74:

1. Correctness
2. Evidence / provenance
3. Avoiding fabricated rulings
4. Retrieval quality
5. User latency
6. Maintainability
7. Cost efficiency
8. Feature breadth

## When you finish a milestone

1. All Definition-of-Done boxes ticked.
2. `CURRENT_STATE.md` updated (replace stale entries; do not append history).
3. New ADR added under `docs/adr/` if you made an architectural decision.
4. PR description summarizes what changed, references the milestone, and lists any deferred follow-ups.
