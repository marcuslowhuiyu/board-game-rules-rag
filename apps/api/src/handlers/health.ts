import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createLogger } from '@bgr/shared';

const logger = createLogger({ base: { handler: 'health' } });

export interface HealthBody {
  status: 'ok';
  commit: string;
  time: string;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const requestId = event.requestContext?.requestId ?? 'unknown';
  const commit = process.env.GIT_COMMIT ?? 'unknown';
  const body: HealthBody = {
    status: 'ok',
    commit,
    time: new Date().toISOString(),
  };

  logger.info('health check', { requestId });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
};
