# ADR-0006: DynamoDB multi-table design for catalog, sessions & messages

- **Status:** Accepted
- **Date:** 2026-09-16
- **Related:** `MASTER_PLAN.md` §10, §13, §45; Milestone 1; closes G7 for the M1 entity set

## Context

Milestone 1 introduces the first DynamoDB-backed entities: `Game` (with embedded `Edition[]`), `ContentPackage`, `Session`, and `Message`. `docs/CONTRADICTIONS_AND_GAPS.md` G7 flagged single-table vs multi-table as an open question. The four entities have very different access patterns:

- **Games** — small dataset (dozens of games initially), read on every page load, occasionally created. Editions embedded on the row.
- **ContentPackages** — small per game (a handful of expansions), queried by `gameId`.
- **Sessions** — short-lived (24h TTL), always addressed by `sessionId`, no cross-session queries at M1.
- **Messages** — high write volume per session, always queried in `sessionId` + monotonic index order.

The classic argument for single-table is amortising RCU/WCU and joining related entities in one Query. That value is real when tables share access patterns; here the four sets don't overlap, and single-table would force generic `pk`/`sk` columns that hide the domain shape from anyone reading the code.

## Decision

Use **four separate on-demand DynamoDB tables**:

| Table    | PK          | SK          | TTL   | Notes                                        |
| -------- | ----------- | ----------- | ----- | -------------------------------------------- |
| games    | `gameId`    | —           | —     | `editions[]` embedded on the row             |
| content  | `gameId`    | `contentId` | —     | Query by `gameId` for all packages           |
| sessions | `sessionId` | —           | `ttl` | DynamoDB TTL sweeps expired rows             |
| messages | `sessionId` | `index`     | —     | Monotonic write; range Query in read order   |

Billing mode: **PAY_PER_REQUEST** (on-demand), matching the master plan.
Encryption: AWS-managed KMS. Point-in-time recovery is enabled on all four tables.
Access from the API Lambda is granted via `Table.grantReadWriteData` per table.

Repository interfaces live in `packages/persistence`. Business logic depends on the interfaces (`GamesRepository`, `SessionsRepository`, `MessagesRepository`) — the DynamoDB implementations are the only place AWS SDK imports appear. This preserves the dependency-inversion rule in `CLAUDE.md`.

## Alternatives considered

- **Single-table with `pk`/`sk`.** Rejected for M1: entities have disjoint access patterns; the schema readability cost outweighed the (small) savings from item collections. Revisitable if a later milestone introduces cross-entity queries.
- **Embedded content on the game row.** Rejected: content packages will grow with expansions/promos and will be filtered/joined at retrieval time (M3+). Keeping them in their own table avoids item-size churn.
- **Sessions in the same table as messages.** Rejected: TTL applies to the whole item; entangling messages with session TTL forces us to duplicate `ttl` on every message row or accept different lifecycle semantics.

## Consequences

- **Positive** — schemas match the domain, IAM policies are naturally scoped per table, TTL is only where it belongs (sessions), each repository is testable in isolation.
- **Negative** — four tables of metadata to keep in sync via CDK; slight duplication of `gameId`/`editionId` across `games` and `content`.
- **Follow-up** — M6 introduces `Rulings` and `IngestionJobs`. Revisit whether those live in new tables or should share existing ones. Slug-based catalog search currently uses `Scan` with client-side filtering; if the catalog outgrows the Scan budget, add a name-prefix GSI or promote search to OpenSearch Serverless — new ADR at that point.
