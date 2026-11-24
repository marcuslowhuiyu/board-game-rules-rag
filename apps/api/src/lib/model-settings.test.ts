import { describe, expect, it, vi } from 'vitest';
import { loadModelCatalog } from '@bgr/ai';
import { InMemoryModelSettingsRepository, type ModelSettingsRepository } from '@bgr/persistence';
import { createLogger } from '@bgr/shared';
import { createModelChoiceCache, resolveModelKeys } from './model-settings.js';

const catalog = loadModelCatalog();

describe('resolveModelKeys', () => {
  it('uses the catalog default for a role with no stored choice', () => {
    const logger = createLogger({ sink: () => undefined });
    expect(resolveModelKeys(catalog, {}, logger)).toEqual(catalog.defaults);
  });

  it('uses an approved stored choice', () => {
    const logger = createLogger({ sink: () => undefined });
    expect(resolveModelKeys(catalog, { answerer: 'claude-haiku-5-5' }, logger)).toEqual({
      ...catalog.defaults,
      answerer: 'claude-haiku-5-5',
    });
  });

  it('falls back to the default for a key the catalog no longer approves, and warns once naming it', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const keys = resolveModelKeys(catalog, { answerer: 'gone-model' }, logger);
    expect(keys.answerer).toBe(catalog.defaults.answerer);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as { level: string; msg: string; key?: string };
    expect(line.level).toBe('warn');
    expect(lines[0]).toContain('gone-model');
  });

  it('treats a key approved for another role only as unapproved', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    expect(resolveModelKeys(catalog, { router: 'claude-sonnet-5-5' }, logger).router).toBe(
      catalog.defaults.router,
    );
    expect(lines).toHaveLength(1);
  });
});

describe('createModelChoiceCache', () => {
  const setup = (ttlMs = 1000) => {
    const repo = new InMemoryModelSettingsRepository();
    const get = vi.spyOn(repo, 'getModelChoices');
    let t = 0;
    const cache = createModelChoiceCache(repo as ModelSettingsRepository, {
      ttlMs,
      now: () => t,
    });
    return { repo, get, cache, advance: (ms: number) => (t += ms) };
  };

  it('reads the repository once for calls within the ttl', async () => {
    const { get, cache, advance } = setup();
    await cache.current();
    advance(999);
    await cache.current();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reads again once the ttl has passed', async () => {
    const { repo, get, cache, advance } = setup();
    expect(await cache.current()).toEqual({});
    await repo.setModelChoice('answerer', 'nova-2-lite', 't');
    advance(1000);
    expect(await cache.current()).toEqual({ answerer: 'nova-2-lite' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces the next read', async () => {
    const { repo, get, cache } = setup();
    await cache.current();
    await repo.setModelChoice('answerer', 'nova-2-lite', 't');
    cache.invalidate();
    expect(await cache.current()).toEqual({ answerer: 'nova-2-lite' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read', async () => {
    const { get, cache } = setup();
    get.mockRejectedValueOnce(new Error('boom'));
    await expect(cache.current()).rejects.toThrow('boom');
    expect(await cache.current()).toEqual({});
  });
});
