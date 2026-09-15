# Milestone 1 — Domain Model, Game Catalog & Sessions

**Master plan reference:** §5, §6, §13, §45, §46, §61. **ADRs:** 0001, 0004. **Depends on:** M0.

## Objective

Model the core domain concepts (Game, Edition, ContentPackage, SourceDocument metadata, Session, Message) and the CRUD surface that the frontend needs to select a game, configure content, and start an anonymous session — all before any AI or retrieval code exists.

## Deliverables

Domain types in `packages/domain`:

- `Game`, `Edition`, `ContentPackage` (with `contentType` enum: `BASE | EXPANSION | PROMO | MODULE | MINI_EXPANSION | OTHER_OPTIONAL_CONTENT`), `SourceDocumentMetadata`, `Session`, `Message`.
- Field shapes per `MASTER_PLAN.md` §6, §13, §45. Include `configurationFingerprint` as a pure function over `(gameId, editionId, sorted enabledContentIds[])`.
- Zod (or equivalent) schemas alongside every type, exported for reuse in API validation.
- Explicit branded id types (`GameId`, `EditionId`, `ContentId`, `SessionId`, `MessageId`) to prevent id-mixing bugs.

Persistence in `packages/persistence`:

- DynamoDB access module. Table design decision recorded inline in this milestone or, if load-bearing, as a new ADR before implementation.
- Repositories: `GamesRepository`, `SessionsRepository`, `MessagesRepository`. Interface-first; DynamoDB implementations.
- Session TTL attribute wired to DynamoDB TTL, initial 24 hours from last activity.

API in `apps/api`:

- Routes (`MASTER_PLAN.md` §46):
  - `GET /games` — search/list.
  - `GET /games/{gameId}` — includes editions and content packages.
  - `POST /games` — create game metadata only (no ingestion).
  - `GET /games/{gameId}/content` — content packages for the game.
  - `POST /sessions` — creates anonymous session, sets HttpOnly cookie carrying `sessionId`.
  - `GET /sessions/{sessionId}` — returns session state (config, expiry).
  - `DELETE /sessions/{sessionId}` — ends session.
- Request/response validation via the Zod schemas from `packages/domain`.
- CORS restricted to the CloudFront origin.
- Structured logs with correlation id per request.

Frontend in `apps/web`:

- Screens: Game Search, Game Configuration, Add Game (metadata only for now).
- Mobile-first layout using a lightweight approach (CSS modules or utility CSS — record the choice in `CURRENT_STATE.md`; not ADR-worthy unless it constrains future work).
- No chat UI yet.

CDK:

- DynamoDB tables added to the dev stack, on-demand capacity.
- Lambda handlers wired to new routes.
- No new secrets, no new IAM roles beyond what handlers need (least privilege).

## Explicitly out of scope

- Any AI, embeddings, retrieval, or ingestion.
- Message send/receive endpoint (that's M4).
- Session summarization (that's M5).
- File uploads (that's M2).

## Verification

1. Unit tests for domain schemas and `configurationFingerprint` (property test: order of `enabledContentIds` does not change the fingerprint).
2. Integration tests hit real DynamoDB Local or an ephemeral CDK-deployed table.
3. A user can, through the deployed dev environment, search a seeded game, view its editions and content, select an edition + expansions + promos, and start a session that returns a `sessionId` cookie.
4. Session record appears in DynamoDB with a TTL attribute ~24h out.
5. `docs/CURRENT_STATE.md` updated to reflect completion and any Milestone-1-only decisions (e.g. table design if not promoted to an ADR).

## Definition of Done

`MASTER_PLAN.md` §71. Evaluation cases N/A (still no rules logic).
