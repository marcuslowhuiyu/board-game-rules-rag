import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

export const ok = <T>(
  body: T,
  extra: { headers?: Record<string, string>; cookies?: string[] } = {},
): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 200,
  headers: { ...jsonHeaders, ...(extra.headers ?? {}) },
  ...(extra.cookies ? { cookies: extra.cookies } : {}),
  body: JSON.stringify(body),
});

export const created = <T>(
  body: T,
  extra: { headers?: Record<string, string>; cookies?: string[] } = {},
): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 201,
  headers: { ...jsonHeaders, ...(extra.headers ?? {}) },
  ...(extra.cookies ? { cookies: extra.cookies } : {}),
  body: JSON.stringify(body),
});

export const noContent = (
  extra: { headers?: Record<string, string>; cookies?: string[] } = {},
): APIGatewayProxyStructuredResultV2 => ({
  statusCode: 204,
  headers: { ...(extra.headers ?? {}) },
  ...(extra.cookies ? { cookies: extra.cookies } : {}),
});

export const errorResponse = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
): APIGatewayProxyStructuredResultV2 => {
  const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return {
    statusCode: status,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  };
};

export const badRequest = (message: string, details?: unknown) =>
  errorResponse(400, 'BAD_REQUEST', message, details);
export const notFound = (message: string) => errorResponse(404, 'NOT_FOUND', message);
export const conflict = (message: string) => errorResponse(409, 'CONFLICT', message);
export const internalError = (message = 'internal error') =>
  errorResponse(500, 'INTERNAL_ERROR', message);
export const tooManyRequests = (code: string, message: string) => errorResponse(429, code, message);
export const serviceUnavailable = (code: string, message: string) =>
  errorResponse(503, code, message);
