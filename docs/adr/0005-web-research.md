# ADR-0005: Web research — bounded loop via `WebSearchProvider`, AgentCore adapter

- **Status:** Accepted
- **Date:** 2026-09-15
- **Related:** `MASTER_PLAN.md` §10, §24, §25, §26, §27, §28; Milestone 6

## Context

Some questions cannot be answered from local ingested sources — the rulebook is silent, the FAQ hasn't been ingested yet, or the ruling requires designer clarification found only on BGG or the publisher's site. Unbounded agentic browsing is a cost, latency, and correctness disaster; a system that silently escalates every question to open-web search betrays the "evidence first" principle. But refusing to look at all leaves obvious gaps.

## Decision

- **Interface:** a `WebSearchProvider` in `packages/ai` (or `packages/research`) with narrow methods (`search(query, opts)`, `fetch(url, opts)`). Business logic depends only on this interface.
- **Primary adapter:** Amazon Bedrock AgentCore Web Search. Because AgentCore regional availability may not match the main workload region (`MASTER_PLAN.md` §10), the research adapter may deploy in a secondary region. The rest of the app never depends on AgentCore-specific APIs — only on the interface.
- **Trigger:** research is only invoked when local retrieval + evidence assessment reports insufficient/contradictory authoritative evidence AND the ruling cache lookup misses. It is never the first port of call.
- **Priority order** (§25): official publisher/designer domain → BoardGameGeek → Reddit → general web. Where a general search surfaces an original publisher document, promote that document into the normal ingestion pipeline rather than treating the snippet as evidence.
- **Bounds** (all configurable, initial values from §24):
  - `maxResearchIterations = 3`
  - `maxSearches = 3`
  - `maxFetchedPages = 5`
  - `maxResearchTokens` from configuration
  - budget exhaustion → the ruling is returned as `INCONCLUSIVE`, never as "best guess without evidence".
- **Provenance:** every research-derived ruling stores canonical URL(s), title, source classification, retrieval timestamp, and the model / prompt version that produced the ruling. Snippets are not stored as a shadow knowledge base.
- **Prompt-injection safety:** fetched web content is passed to the model as untrusted data blocks, never merged into system instructions.
- **Ruling cache:** validated rulings persist per `MASTER_PLAN.md` §28 with a semantic index over the canonical question. Cache lookups check `configurationFingerprint` and `knowledgeRevision` before reuse.

## Alternatives considered

- **Direct integration with a specific search API (Google/Bing/Brave).** Rejected: violates the abstraction principle and picks a provider without evaluation. Can be added as another `WebSearchProvider` implementation later.
- **Give the model tool-use freedom over the whole loop.** Rejected: unbounded loops break cost and correctness discipline. The application controls the loop; the model advises whether more evidence is needed.
- **Cache raw fetched pages as knowledge base entries.** Rejected: creates a mirror of third-party content with copyright and freshness problems. Cache the *ruling* plus source pointers, not the source content itself.

## Consequences

- **Positive:** an obvious escape valve for missing knowledge without abandoning evidence-first behaviour. Bounded loops keep cost predictable. Cached rulings turn repeated obscure questions into cheap lookups.
- **Negative:** two-region deployment adds ops complexity if AgentCore forces it. AgentCore availability and cost characteristics are early-stage — a fallback provider will likely be needed within Milestone 6 or shortly after.
- **Follow-up:** Milestone 6 spec must record the concrete AgentCore region and any fallback provider actually wired in. If AgentCore is not viable at implementation time, a follow-up ADR replaces the primary adapter without changing the interface or the loop.
