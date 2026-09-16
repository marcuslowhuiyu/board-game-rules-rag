import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export const SESSION_COOKIE_NAME = 'bgr_session';

/**
 * Session cookie. The frontend and API share an origin (CloudFront serves the
 * SPA at `/` and forwards `/api/*` to API Gateway), so this is a first-party
 * cookie: `SameSite=Lax` is appropriate and avoids Safari's third-party-cookie
 * restrictions that break cross-site `SameSite=None` cookies. See ADR-0007.
 */
export function buildSessionCookie(sessionId: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return parts.join('; ');
}

export function buildExpiredSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function readSessionCookie(event: APIGatewayProxyEventV2): string | null {
  const raw = event.cookies ?? [];
  for (const c of raw) {
    const idx = c.indexOf('=');
    if (idx < 0) continue;
    const name = c.slice(0, idx).trim();
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(c.slice(idx + 1));
    }
  }
  return null;
}
