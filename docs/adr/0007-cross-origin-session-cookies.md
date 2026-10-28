# ADR-0007: Same-origin routing via CloudFront + first-party session cookie

- **Status:** Accepted
- **Date:** 2026-09-16
- **Related:** `MASTER_PLAN.md` §45, §48; ADR-0004; Milestone 1; closes G13
- **Supersedes:** the cross-origin `SameSite=None` proposal that briefly existed in an earlier draft of this file — never accepted.

## Context

Milestone 0 gave us two hosts: the SPA on CloudFront and the API on API Gateway HTTP API. Master plan §45 prefers cookie-based session identity and ADR-0004 pins that cookie to `HttpOnly`. `planning/CONTRADICTIONS_AND_GAPS.md` G13 called out that the two hosts sit on different origins.

Modern browsers (Safari especially, but Chrome and Firefox are trending the same way) treat cookies on requests to a different site as third-party — even when the cookie carries `SameSite=None; Secure`. Safari's ITP already refuses to send third-party cookies in most contexts; Chrome's third-party cookie phase-out is ongoing. That behaviour would silently break the session as soon as we exercised the app in a real browser (especially on mobile Safari — the primary target).

`SameSite=Lax` first-party cookies are unaffected by third-party restrictions and require no CORS credential negotiation.

## Decision

**Route the API through CloudFront.** CloudFront is the single public origin for the browser:

- **Default behavior** (`/*`) — S3 static site (unchanged).
- **`/api/*` behavior** — forwards to the API Gateway HTTP API origin (`<apiId>.execute-api.<region>.amazonaws.com`) with:
  - `AllowedMethods: ALLOW_ALL` (POST/DELETE needed for `/api/games`, `/api/sessions/...`).
  - `CachePolicy: CACHING_DISABLED` (API responses must not be cached at the edge).
  - `OriginRequestPolicy: ALL_VIEWER_EXCEPT_HOST_HEADER` (forward cookies/query/all headers except `Host`, which must remain the API's own hostname so it matches its api-id).
  - A CloudFront Function on `viewer-request` that strips the `/api` prefix before the request reaches API Gateway. The Function is inline and tested via `hasResourceProperties`.

The browser therefore reaches every API endpoint at `<cloudfront-domain>/api/*` — same origin as the SPA — and API Gateway keeps its throttling, access logs, CloudWatch metrics, and API-id routing untouched (it just sees rewritten paths).

With that in place:

- **Session cookie**: `HttpOnly; Secure; SameSite=Lax; Path=/` (cookie name `bgr_session`). First-party by construction. The browser sends it on the SPA's own credentialed and non-credentialed fetches to `/api/*`.
- **`DELETE /sessions/{id}`** returns the same cookie name with `Max-Age=0` so the browser drops it.
- **API Gateway CORS**: **removed**. Same-origin means the browser never issues a preflight; a CORS policy is redundant, so we leave `HttpApi` without a `corsPreflight` block. Callers hitting the API directly (curl, integration tests) never needed CORS.
- **Frontend `fetch`**: `credentials: 'same-origin'` (the fetch default, stated explicitly). No `credentials: 'include'` needed.
- **Frontend base URL**: `/api` by default. Overridable via `VITE_API_URL` for local dev proxying.
- ADR-0004's TTL and lifecycle rules are unchanged (24h from last activity, refreshed on activity, DynamoDB TTL attribute drives expiration).

## Alternatives considered

- **Cross-origin cookies with `SameSite=None; Secure` and explicit CORS.** Rejected as unreliable on Safari (ITP) and future-fragile on Chrome; also forced `AllowCredentials: true` with a wildcard-forbidden `AllowOrigins`, which is a common source of subtle CSRF configuration mistakes.
- **`Authorization: Bearer` token in `localStorage`.** Rejected: readable by any script; requires client-side rotation; diverges from the plan's cookie preference.
- **Custom domain fronting both.** Deferred: same-origin via the CloudFront distribution hostname already solves the problem for the private beta. A custom domain (ACM cert + Route 53) is a Milestone 8/9 concern.

## Consequences

- **Positive** — the session cookie is first-party in every mainstream browser (including Safari); there's no CORS surface to misconfigure; API Gateway keeps its native metrics and throttling; the operator-facing API URL is unchanged for direct calls.
- **Negative** — CloudFront now sits on the API path. That adds a few milliseconds of edge latency per API call, one more moving piece (the CloudFront Function) to reason about, and a small dependency loop at deploy time (the CDK stack references the API's `apiId` when it constructs the origin — CloudFormation handles the order). CSRF is now a live concern for state-changing endpoints (`POST /sessions`, `POST /games` today; `POST /sessions/{id}/messages` in M4); we accept it for M1 because there are no user accounts and the blast radius is limited to the private beta, and M4 will add a double-submit CSRF token before the message endpoint ships.
- **Follow-up** — measure edge latency on the deployed dev environment during M3/M4 benchmarking. If it becomes a problem, revisit (candidate: CloudFront regional edge caches or moving the API to a custom domain and dropping CloudFront on that path).
