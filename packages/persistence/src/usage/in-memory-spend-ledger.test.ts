import { describe, expect, it } from 'vitest';
import { InMemorySpendLedger } from './in-memory-spend-ledger.js';

describe('InMemorySpendLedger', () => {
  it('returns 0 for a day never added to', async () => {
    const ledger = new InMemorySpendLedger();
    expect(await ledger.spentUsd('2026-10-30')).toBe(0);
  });

  it('accumulates adds for the same day', async () => {
    const ledger = new InMemorySpendLedger();
    await ledger.add('2026-10-30', 0.25);
    await ledger.add('2026-10-30', 0.5);
    expect(await ledger.spentUsd('2026-10-30')).toBeCloseTo(0.75);
  });

  it('keeps days separate', async () => {
    const ledger = new InMemorySpendLedger();
    await ledger.add('2026-10-30', 0.25);
    expect(await ledger.spentUsd('2026-10-31')).toBe(0);
  });

  it('rejects a negative or non-finite amount and records nothing', async () => {
    const ledger = new InMemorySpendLedger();
    await expect(ledger.add('2026-10-30', -1)).rejects.toThrow(/usd/);
    await expect(ledger.add('2026-10-30', Number.NaN)).rejects.toThrow(/usd/);
    expect(await ledger.spentUsd('2026-10-30')).toBe(0);
  });
});
