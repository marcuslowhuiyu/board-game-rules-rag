# ADR-0009: CI runs on a minimal GitHub Actions budget

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Marcus Low, Claude Code
- **Related:** Milestone 0 (CI + security workflows), Milestone 9 (dependency-scanning gate)

## Context

The repo is private, so every GitHub Actions minute counts against the account's monthly quota, which is shared with other projects. In October 2026 the account hit its spending limit and jobs stopped starting at all. The M0 setup was spending minutes on runs that added no signal:

- `security.yml` ran CodeQL on every PR, every push to `main` and weekly. CodeQL is not enabled for private repos on this plan, so every run failed.
- Every PR ran two workflows (CI, plus Security's `pnpm audit` as a separate job). Each job re-installed dependencies and was billed its own rounded-up minute.
- CI re-ran on every push to `main`, re-checking code its PR run had already gated.
- Docs-only changes ran full CI and a dev deploy.
- Dependabot opened about three grouped PRs a week, each triggering both workflows.

## Decision

- **CI** (`ci.yml`) runs only on `pull_request`, never on push to `main`. It skips draft PRs (the job's `if` is false, and skipped jobs cost nothing) and paths matching `**.md` / `docs/**`. It has a 15-minute timeout and a manual `workflow_dispatch`.
- **`pnpm audit`** is a step in the CI job and stays non-blocking. `security.yml` is deleted, along with CodeQL.
- **Deploy** (`deploy-dev.yml`) still runs on push to `main`, but ignores docs-only merges, and has a 30-minute timeout.
- **Dependabot** checks monthly and opens one grouped PR per ecosystem (npm, github-actions), with a limit of one open PR each. Security updates are unaffected.

Working practice: open PRs as **drafts** while iterating, run the full gate locally (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm synth`), and mark the PR ready for review only for the final CI run.

## Alternatives considered

- **Make the repo public** for free Actions minutes. This is not ruled out, and it would also make CodeQL and branch protection available, but it is a disclosure decision for the operator and not a CI tweak.
- **Keep CodeQL behind an `if` on repo visibility.** That is more machinery for a job that cannot run on this plan. Reinstate it if the repo goes public.
- **Self-hosted runner.** Needs an always-on machine plus ops overhead. Not worth it at this scale.

## Consequences

- **Positive:** a typical PR costs one job run, at final review only. Merges cost a single deploy run, and docs-only merges cost nothing.
- **Negative:**
  - Nothing does static security analysis until CodeQL comes back.
  - Code on `main` is not re-checked after merge. A semantic conflict between two PRs that each passed could slip through, which is acceptable with one active branch at a time.
  - A PR containing only docs gets no full CI run. (Since 2026-10-27 a stub reports the required check for it; see Revisions.)
- **Follow-up:** M9's dependency-scanning gate (blocking high-severity audit findings) must make the audit step blocking. Revisit this ADR if the repo goes public.

## Revisions

### 2026-10-27 — Branch protection on `main`

The repo is public now, so branch protection is available. `main` now requires a pull request (no approvals, since there is one human), the `Lint / Typecheck / Test / Synth` check from GitHub Actions, and applies to admins. Force pushes and deletion are blocked. "Require branches to be up to date" is off: it would re-run CI each time `main` moves.

`ci.yml` still skips docs-only PRs, which would leave the required check waiting forever. `ci-docs.yml` fills that gap: it runs only when a PR touches `**.md` or `docs/**`, and reports a job with the same name that always passes. A PR touching both code and docs triggers both workflows. That is safe: GitHub requires every check with the required name to pass, so the real job still gates the merge. This was confirmed on PR #28, where a failing stub blocked the merge even though the real job passed.
