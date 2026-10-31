import { assertSpendDay, assertSpendUsd, type SpendLedger } from './spend-ledger.js';

export class InMemorySpendLedger implements SpendLedger {
  private readonly totals = new Map<string, number>();

  async spentUsd(day: string): Promise<number> {
    assertSpendDay(day);
    return this.totals.get(day) ?? 0;
  }

  async add(day: string, usd: number): Promise<void> {
    assertSpendDay(day);
    assertSpendUsd(usd);
    this.totals.set(day, (this.totals.get(day) ?? 0) + usd);
  }
}
