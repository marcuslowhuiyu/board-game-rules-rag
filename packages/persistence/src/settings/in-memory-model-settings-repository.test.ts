import { describe, expect, it } from 'vitest';
import { InMemoryModelSettingsRepository } from './in-memory-model-settings-repository.js';

const T = '2026-11-24T00:00:00.000Z';

describe('InMemoryModelSettingsRepository', () => {
  it('returns {} when nothing is stored', async () => {
    expect(await new InMemoryModelSettingsRepository().getModelChoices()).toEqual({});
  });

  it('stores a choice per role and keeps the others', async () => {
    const repo = new InMemoryModelSettingsRepository();
    await repo.setModelChoice('answerer', 'claude-haiku-5-5', T);
    expect(await repo.getModelChoices()).toEqual({ answerer: 'claude-haiku-5-5' });
    await repo.setModelChoice('router', 'nova-micro', T);
    await repo.setModelChoice('answerer', 'nova-2-lite', T);
    expect(await repo.getModelChoices()).toEqual({ router: 'nova-micro', answerer: 'nova-2-lite' });
  });

  it('rejects an unknown role', async () => {
    await expect(
      new InMemoryModelSettingsRepository().setModelChoice('judge' as never, 'x', T),
    ).rejects.toThrow(/role/);
  });
});
