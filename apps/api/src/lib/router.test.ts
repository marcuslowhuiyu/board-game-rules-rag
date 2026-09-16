import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@bgr/domain';
import { makeHandler, route } from './router.js';
import { ok } from './responses.js';
import { makeEvent } from '../test-support.js';

describe('router', () => {
  it('routes by method and path template', async () => {
    const handler = makeHandler([
      route('GET', '/foo/{bar}', async (_ctx, params) => ok({ bar: params['bar'] })),
    ]);
    const res = await handler(makeEvent({ rawPath: '/foo/xyz' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ bar: 'xyz' });
  });

  it('returns 404 when nothing matches', async () => {
    const handler = makeHandler([]);
    const res = await handler(makeEvent({ rawPath: '/nope' }));
    expect(res.statusCode).toBe(404);
  });

  it('maps ZodError to 400', async () => {
    const handler = makeHandler([
      route('GET', '/x', async () => {
        z.object({ a: z.string() }).parse({});
        return ok({});
      }),
    ]);
    const res = await handler(makeEvent({ rawPath: '/x' }));
    expect(res.statusCode).toBe(400);
  });

  it('maps ConflictError to 409 and NotFoundError to 404', async () => {
    const conflictHandler = makeHandler([
      route('GET', '/c', async () => {
        throw new ConflictError('dup');
      }),
    ]);
    expect((await conflictHandler(makeEvent({ rawPath: '/c' }))).statusCode).toBe(409);

    const notFoundHandler = makeHandler([
      route('GET', '/n', async () => {
        throw new NotFoundError('Game', 'x');
      }),
    ]);
    expect((await notFoundHandler(makeEvent({ rawPath: '/n' }))).statusCode).toBe(404);
  });

  it('maps unhandled errors to 500', async () => {
    const handler = makeHandler([
      route('GET', '/x', async () => {
        throw new Error('boom');
      }),
    ]);
    const res = await handler(makeEvent({ rawPath: '/x' }));
    expect(res.statusCode).toBe(500);
  });
});
