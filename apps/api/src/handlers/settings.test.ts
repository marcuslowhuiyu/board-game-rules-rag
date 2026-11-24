import { describe, expect, it } from 'vitest';
import { loadModelCatalog, MODEL_ROLES } from '@bgr/ai';
import { makeHandler } from '../lib/router.js';
import { bodyAs, makeEvent, makeTestContext } from '../test-support.js';
import { settingsRoutes, type ModelSettingsView } from './settings.js';

describe('settings handlers', () => {
  const catalog = loadModelCatalog();
  const build = () => {
    const ctx = makeTestContext();
    const handler = makeHandler(settingsRoutes(() => ctx));
    const get = () => handler(makeEvent({ rawPath: '/settings/models' }));
    const put = (role: string, body: string | undefined) =>
      handler(
        makeEvent({
          rawPath: `/settings/models/${role}`,
          requestContext: { http: { method: 'PUT' } } as never,
          ...(body !== undefined ? { body } : {}),
        }),
      );
    return { ctx, get, put };
  };

  it('GET on an empty store shows the defaults and the approved options in order', async () => {
    const { get } = build();
    const res = await get();
    expect(res.statusCode).toBe(200);
    const view = bodyAs<ModelSettingsView>(res);
    expect(view.roles.map((r) => r.role)).toEqual(['router', 'reranker', 'answerer']);
    for (const r of view.roles) {
      expect(r.chosen).toBe(r.default);
      expect(r.default).toBe(catalog.defaults[r.role]);
      expect(r.options.map((o) => o.key)).toEqual(catalog.approved[r.role]);
    }
    const first = view.roles[0]!.options[0]!;
    const entry = catalog.models[first.key]!;
    expect(first).toEqual({
      key: entry.key,
      displayName: entry.displayName,
      inputUsdPerMTok: entry.inputUsdPerMTok,
      outputUsdPerMTok: entry.outputUsdPerMTok,
    });
    expect(MODEL_ROLES).toHaveLength(3);
  });

  it('PUT answerer to claude-haiku-5-5 returns it chosen and a later GET agrees', async () => {
    const { get, put } = build();
    const res = await put('answerer', JSON.stringify({ key: 'claude-haiku-5-5' }));
    expect(res.statusCode).toBe(200);
    expect(bodyAs<ModelSettingsView>(res).roles.find((r) => r.role === 'answerer')?.chosen).toBe(
      'claude-haiku-5-5',
    );
    const after = bodyAs<ModelSettingsView>(await get());
    expect(after.roles.find((r) => r.role === 'answerer')?.chosen).toBe('claude-haiku-5-5');
  });

  it('PUT invalidates the choice cache', async () => {
    const { ctx, put } = build();
    let invalidated = 0;
    ctx.modelChoices.invalidate = () => {
      invalidated++;
    };
    await put('answerer', JSON.stringify({ key: 'claude-haiku-5-5' }));
    expect(invalidated).toBe(1);
  });

  it('PUT an unapproved key for the role is 400 VALIDATION and stores nothing', async () => {
    const { get, put } = build();
    const before = await get();
    const res = await put('answerer', JSON.stringify({ key: 'nova-micro' }));
    expect(res.statusCode).toBe(400);
    expect(bodyAs<{ error: { code: string } }>(res).error.code).toBe('VALIDATION');
    expect((await get()).body).toBe(before.body);
  });

  it('PUT an unknown role is 400 VALIDATION', async () => {
    const { put } = build();
    const res = await put('judge', JSON.stringify({ key: 'nova-micro' }));
    expect(res.statusCode).toBe(400);
    expect(bodyAs<{ error: { code: string } }>(res).error.code).toBe('VALIDATION');
  });

  it('PUT with a non-JSON body or no key is 400', async () => {
    const { put } = build();
    expect((await put('answerer', 'not json')).statusCode).toBe(400);
    expect((await put('answerer', '{}')).statusCode).toBe(400);
    expect((await put('answerer', undefined)).statusCode).toBe(400);
    expect((await put('answerer', JSON.stringify({ key: 5 }))).statusCode).toBe(400);
  });
});
