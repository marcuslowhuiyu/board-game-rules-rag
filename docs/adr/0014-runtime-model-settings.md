# ADR-0014: Runtime model settings

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Marcus Low, Claude Code
- **Related:** ADR-0011, ADR-0012, ADR-0013, Milestone 4 (Settings, step 5)

## Context

ADR-0011 put the approved models and the defaults per role (router, reranker, answerer) in a configured catalog. Changing a default meant a deploy. The operator wants to switch the model for a role from the web app while testing, without redeploying, and every stored answer must still record the model and prompt version that served it (`servedBy`, unchanged).

## Decision

- **Storage.** The chosen model key per role is one item, `pk='settings#models'`, in the existing usage table, with one string attribute per role and an `updatedAt`. It is one small row, so it gets no new table. Spend rows are keyed by a `YYYY-MM-DD` date, so the key cannot collide with them. The item has no TTL. A role with no attribute uses the catalog default. Reads are strongly consistent; a write sets one role and leaves the others. `persistence` uses a local role union and does not depend on `@bgr/ai`.
- **Read path.** Each question reads the choices through a cache. The TTL is the config value `modelSettingsCacheMs`, which CDK sets to 60000 (env `MODEL_SETTINGS_CACHE_MS`). A failed read logs a warning and returns the last good choices (or none, which resolves to the catalog defaults), so a settings read failure never fails a question; the read time is not refreshed, so the next question retries. A successful PUT invalidates the cache. The answer pipelines are memoized per key triple (`router|reranker|answerer`) and built on first use, so changing a model builds new roles once and a switch back reuses the old pipeline.
- **Fallback.** A role with no stored choice, or whose stored key the catalog no longer approves (the catalog was edited after the choice was saved), uses the catalog default, and a warning is logged. The question is still answered; it is never a 500. GET reads the repository directly, not the cache, so the Settings screen shows the stored truth (or an error), never a stale or fallback value; it shows the resolved key, so a stale choice appears as the default.
- **Validation.** `PUT /settings/models/{role}` takes `{ "key": ... }`. An unknown role, a body that is not that shape, or a key not approved for the role is rejected with 400 `VALIDATION`, nothing is stored, and GET still shows the old choice. `GET /settings/models` returns each role's chosen key, the catalog default and the approved options with prices.
- **Open in dev.** The Settings API and screen are unauthenticated and open in dev, by the operator's choice, because nothing is released yet. Anyone who can reach the API can change the models and therefore the spend. Protecting them is an M10 launch blocker.
- **CloudFront.** The web app has no URL routes (screens are state-based). The old distribution-wide 403/404 to `index.html` rewrite turned API 403 and 404 responses into a 200 HTML page, which breaks the client's JSON parsing and would break 404 handling (for example, a session that has ended). It is replaced by a viewer-request function on the default (site) behavior only, which rewrites extensionless paths to `/index.html`. The `/api/*` behavior has no function, so API errors reach clients unchanged.

## Alternatives considered

- **A new settings table.** Rejected: one row does not justify a table and its IAM and CDK surface.
- **Read the item on every question.** Rejected: an extra read per question for a value that changes rarely.
- **Re-deploy to change a default.** Rejected: too slow for model testing.
- **Keep the distribution-wide error rewrite.** Rejected: it hides API errors behind a 200.

## Consequences

- **Positive:** the model per role changes without a deploy, every answer still records what served it, and a bad or outdated stored value degrades to the default instead of failing.
- **Negative and known limits:**
  - **The cache is per Lambda container.** A PUT invalidates only the container that handled it; others keep the old choice for up to `modelSettingsCacheMs` (60 s).
  - **The settings and spend rows share a table**, so the table's name and IAM no longer say only "spend".
  - **No authentication in dev** (see above).
  - **Pipelines are never evicted**, which is bounded by the catalog's approved keys.
- **Follow-up:** protect the Settings API and screen before launch (M10).
