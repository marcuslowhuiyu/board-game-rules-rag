import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Logger } from '@bgr/shared';
import { createLogger } from '@bgr/shared';
import { ZodError } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '@bgr/domain';
import { badRequest, conflict, internalError, notFound } from './responses.js';

export interface RequestContext {
  event: APIGatewayProxyEventV2;
  requestId: string;
  logger: Logger;
  path: string;
  method: string;
}

export type RouteHandler = (
  ctx: RequestContext,
  params: Record<string, string>,
) => Promise<APIGatewayProxyStructuredResultV2>;

export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export function route(method: string, template: string, handler: RouteHandler): Route {
  const paramNames: string[] = [];
  const regex = template
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => {
      if (seg.startsWith('{') && seg.endsWith('}')) {
        paramNames.push(seg.slice(1, -1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return {
    method: method.toUpperCase(),
    pattern: new RegExp(`^${regex}/?$`),
    paramNames,
    handler,
  };
}

const baseLogger = createLogger({ base: { app: 'bgr-api' } });

export function makeHandler(routes: Route[]) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const requestId = event.requestContext?.requestId ?? 'unknown';
    const method = event.requestContext?.http?.method ?? 'GET';
    const path = event.rawPath || '/';
    const logger = baseLogger.child({ requestId, method, path });

    const ctx: RequestContext = { event, requestId, logger, method, path };

    try {
      for (const r of routes) {
        if (r.method !== method) continue;
        const match = r.pattern.exec(path);
        if (!match) continue;
        const params: Record<string, string> = {};
        r.paramNames.forEach((name, i) => {
          params[name] = match[i + 1] ?? '';
        });
        logger.info('route matched', { pattern: r.pattern.source });
        return await r.handler(ctx, params);
      }
      logger.info('no route matched');
      return notFound(`no route for ${method} ${path}`);
    } catch (err) {
      return mapErrorToResponse(err, logger);
    }
  };
}

export function mapErrorToResponse(
  err: unknown,
  logger: Logger,
): APIGatewayProxyStructuredResultV2 {
  if (err instanceof ZodError) {
    logger.warn('validation error', { issues: err.issues });
    return badRequest('invalid request body', err.issues);
  }
  if (err instanceof ValidationError) {
    logger.warn('validation error', { issues: err.issues });
    return badRequest(err.message, err.issues);
  }
  if (err instanceof NotFoundError) {
    logger.info('not found', { message: err.message });
    return notFound(err.message);
  }
  if (err instanceof ConflictError) {
    logger.info('conflict', { message: err.message });
    return conflict(err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error('unhandled error', { message });
  return internalError();
}

export function parseJsonBody<T>(event: APIGatewayProxyEventV2): T {
  const raw = event.body ?? '';
  if (raw.length === 0) return {} as T;
  const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  return JSON.parse(body) as T;
}
