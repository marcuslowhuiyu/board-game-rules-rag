# Architecture Decision Records

Long-lived architectural decisions for the Board Game Rules RAG project.

## Format

We use lightweight ADRs (Michael Nygard style). Every ADR file is:

```
NNNN-short-kebab-slug.md
```

where `NNNN` is a zero-padded serial. Use `0000-adr-template.md` as the starting point.

## Status lifecycle

- **Proposed** — under discussion, not yet in force.
- **Accepted** — the current decision.
- **Superseded by ADR-NNNN** — replaced; keep the file, add the pointer.
- **Deprecated** — no longer relevant, no replacement needed.

Never delete or rewrite an accepted ADR. Add a new one and mark the old as superseded.

## When to write one

Write a new ADR whenever you make a decision that:

- constrains future work (e.g. choice of vector store, model provider, session strategy),
- would be surprising to a new contributor,
- resolves an item listed in `planning/CONTRADICTIONS_AND_GAPS.md`, or
- overrides an existing ADR.

Do **not** write ADRs for routine implementation choices (variable names, file layout inside a package, minor library picks). Those live in code.

## Index

| ID | Title | Status |
|----|-------|--------|
| [0001](0001-runtime-stack.md) | Runtime stack: TypeScript, Node, pnpm, CDK | Accepted |
| [0002](0002-vector-store.md) | Vector store: Amazon S3 Vectors (initial) | Accepted |
| [0003](0003-model-interface.md) | Model interface and Bedrock Converse adapter | Accepted |
| [0004](0004-session-memory.md) | Session memory: rolling summary + recent turns | Accepted |
| [0005](0005-web-research.md) | Web research: bounded loop via AgentCore | Accepted |
| [0006](0006-dynamodb-multi-table-catalog-sessions.md) | DynamoDB multi-table design for catalog, sessions & messages | Accepted |
| [0007](0007-cross-origin-session-cookies.md) | Cross-origin session cookies (SameSite=None; Secure) | Accepted |
| [0008](0008-document-ingestion-pipeline.md) | Document ingestion — Step Functions + S3 + DynamoDB, deterministic PDF first | Accepted |
| [0009](0009-ci-minutes-budget.md) | CI runs on a minimal GitHub Actions budget | Accepted |
| [0010](0010-source-provenance-evidence.md) | Source provenance is stored as evidence | Accepted |
| [0011](0011-model-roles-and-catalog.md) | Model roles and a configured model catalog | Accepted |
| [0012](0012-rules-answering-pipeline.md) | Rules answering pipeline | Accepted |
