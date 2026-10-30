/**
 * Running AI spend per Singapore calendar day. Structurally identical to the
 * `SpendLedger` in `@bgr/answering`; persistence does not depend on that package.
 */
export interface SpendLedger {
  spentUsd(day: string): Promise<number>;
  add(day: string, usd: number): Promise<void>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertSpendDay(day: string): void {
  if (!DAY_PATTERN.test(day)) throw new Error(`invalid spend day (want YYYY-MM-DD): ${day}`);
}

export function assertSpendUsd(usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`invalid spend usd: ${usd}`);
}
