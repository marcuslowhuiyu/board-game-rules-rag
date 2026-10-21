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
- Follow the workflow in `MASTER_PLAN.md` §59 (Claude Code Execution Rules): branch → read docs → implement → tests → quality checks → docs → update `CURRENT_STATE.md` → **independent Codex review** (see below) → PR.
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

## Independent review (Codex)

Every reviewable unit of work gets a review from a second model before it goes to the human: each slice of a multi-slice change (e.g. `M2-REVIEW-FIXES.md`'s R1/R2/R3), each milestone before its PR leaves draft, and any other PR with non-trivial code.

1. Commit the slice, with all local quality gates passing (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm synth`).
2. Run the Codex reviewer against the branch's base, in the background:
   `/codex:review --base main --background`. Check progress with `/codex:status` and read results with `/codex:result`.
   For a design-level challenge of a risky decision, add `/codex:adversarial-review --base main "<focus>"`.
3. Triage every finding as either **fixed** (in a follow-up commit on the same branch, with a test) or **declined** (with a one-line reason). Do not apply findings blindly. Codex is a reviewer, not an authority. Verify each claim against the code first.
4. Hand the slice to the human with the review summary and the triage. The human review still happens; Codex does not replace it.

Use the on-demand review above, not the Codex stop-time review gate (`/codex:setup --enable-review-gate`). The gate reviews every turn, including turns with no code changes, which burns Codex usage limits and slows every turn down.

If Codex fails with `400 … model is not supported when using Codex with a ChatGPT account`, OpenAI has retired the model in `~/.codex/config.toml` for ChatGPT logins. Change `model` there to one that `codex exec -m <model> "Reply OK"` accepts.

## When you finish a milestone

1. All Definition-of-Done boxes ticked.
2. `CURRENT_STATE.md` updated (replace stale entries; do not append history).
3. New ADR added under `docs/adr/` if you made an architectural decision.
4. Independent Codex review run on the full milestone branch, with findings triaged (see above).
5. PR description summarizes what changed, references the milestone, lists any deferred follow-ups, and includes the Codex review triage.
