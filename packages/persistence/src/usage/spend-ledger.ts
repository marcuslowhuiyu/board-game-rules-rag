/**
 * Running AI spend per Singapore calendar day. Structurally identical to the
 * `SpendLedger` in `@bgr/answering`; persistence does not depend on that package.
 */
export interface SpendLedger {
  spentUsd(day: string): Promise<number>;
  add(day: string, usd: number): Promise<void>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts only a real calendar day: 2026-02-31 and 2026-13-01 are rejected. */
export function assertSpendDay(day: string): void {
  const invalid = (): Error => new Error(`invalid spend day (want YYYY-MM-DD): ${day}`);
  if (!DAY_PATTERN.test(day)) throw invalid();
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  if (!new Date(Date.UTC(y, m - 1, d)).toISOString().startsWith(day)) throw invalid();
}

export function assertSpendUsd(usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`invalid spend usd: ${usd}`);
}
