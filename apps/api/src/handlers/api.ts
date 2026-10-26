import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getContext } from '../lib/context.js';
import { makeHandler, route } from '../lib/router.js';
import { ok } from '../lib/responses.js';
import { gameRoutes } from './games.js';
import { sessionRoutes } from './sessions.js';
import { uploadRoutes } from './uploads.js';
import { ingestionRoutes } from './ingestion.js';
import { sourceRoutes } from './sources.js';

const healthRoute = route('GET', '/health', async () => {
  const commit = process.env['GIT_COMMIT'] ?? 'unknown';
  return ok({ status: 'ok', commit, time: new Date().toISOString() });
});

const routes = [
  healthRoute,
  ...gameRoutes(getContext),
  ...sessionRoutes(getContext),
  ...uploadRoutes(getContext),
  ...ingestionRoutes(getContext),
  ...sourceRoutes(getContext),
];

const inner = makeHandler(routes);

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  return inner(event);
};
