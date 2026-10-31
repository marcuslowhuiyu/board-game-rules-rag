/** Running AI spend per Singapore calendar day (key from `singaporeDayKey`). */
export interface SpendLedger {
  spentUsd(day: string): Promise<number>;
  add(day: string, usd: number): Promise<void>;
}

const SINGAPORE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' of the given instant in Asia/Singapore. */
export function singaporeDayKey(now: Date): string {
  const part = (type: string): string =>
    SINGAPORE_DAY.formatToParts(now).find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
