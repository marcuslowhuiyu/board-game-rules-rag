# ADR-0010: Source provenance is stored as evidence

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Marcus Low, Claude Code
- **Related:** ADR-0008, Milestone 4 (ingestion), Milestone 6 (source verification), MASTER_PLAN §7, §8, §13

## Context

A community forum post was once ingested labelled as an official FAQ, and nothing in the system noticed. Two things made that possible. The add-source screen guessed a trust tier from the document type (FAQ became official). And the ingestion pipeline kept only the resulting tier label, so there was no record of why a source was trusted. A wrong label looked identical to a right one.

Answers cite sources, and the answer policy weighs them by trust tier. A tier that nobody can justify undermines that. A source should earn its tier from evidence that the system checked or the operator declared, and that evidence should be stored so "why do you trust this?" always has an answer.

## Decision

- **Provenance is a list of evidence items on each source document** (`SourceDocument.provenance`, default empty), defined in `packages/domain/src/provenance.ts`. The kinds are:
  - `OPERATOR_ATTESTED`: the operator declared the tier (`authority`, `recordedAt`).
  - `SOURCE_HOST`: the host the content was fetched from (`host`).
  - `UPLOADED_FILE`: the content came from an uploaded file (optional `filename`).
  - `COMMUNITY_HOST_DOWNGRADE`: the system lowered the tier because the host is a known community site (`host`, `from`, `to`).
  - `COMMUNITY_CONTENT_REMOVED`: the HTML parser found and removed comment regions (`regions` count).
- **The tier stays the stored rank.** Retrieval and answer policy keep reading the tier as before. Provenance explains the tier and does not replace it.
- **The operator's declaration is evidence, not a default.** The add-source screen requires an explicit trust tier, and the declaration is recorded as `OPERATOR_ATTESTED`.
- **CLASSIFY builds the list and FINALIZE publishes it.** The duplicate and reinstate paths keep the existing document's provenance, so re-ingesting does not erase or rewrite history.
- **The HTML parser removes WordPress comment regions** (`#comments`, `.comments-area`, `.comment-list`) and counts them, so reader comments are not indexed as if the author wrote them.
- **`GET /sources/{id}` returns the provenance list.** An operator script (`evals/scripts/backfill-provenance.ts`) adds operator-confirmed evidence to documents that existed before this change.

## Alternatives considered

- **Infer the tier automatically from the document type.** This is the behaviour that caused the mislabel. Rejected.
- **Store a single "reason" string next to the tier.** It cannot be checked, extended or counted, and it would not scale to several independent checks per source. A typed list can.
- **Verify official hosts and accounts now.** This is the right direction, but it needs per-publisher data and rehost detection. It is deferred to M6 so that M4 can ship the storage the checks will write into.

## Consequences

- **Positive:** every source can answer why it has its tier. Operator declarations are explicit and dated. Downgrades and content removals are visible and countable. M6 can add verification kinds without a data migration, because the list is open to new kinds. Because `ProvenanceEvidenceSchema` is a closed discriminated union, code older than a newly added kind (including a rollback) fails to parse documents carrying that kind, so a new kind must ship before any document is written with it, and rollbacks across it need care.
- **Negative:**
  - Evidence from the operator is still only a declaration. Nothing checks it yet.
  - **Known limit:** the parser removes only the comment markup it recognises (the WordPress selectors above). A mixed page with other forum or comment markup is not caught by the parser. The operator's check when adding the source is the safeguard until M6's per-post tiers.
  - Documents ingested before this change have empty provenance until backfilled.
- **Follow-up:** M6 adds verification kinds (official host and account checks, rehost detection, per-post tiers). Run the backfill script against existing documents with the operator's confirmation.
