import { describe, expect, it } from 'vitest';
import { scoreRouting } from './routing.js';

describe('scoreRouting', () => {
  it('computes accuracy, confusion and fallbacks', () => {
    const r = scoreRouting(
      ['simple', 'complex', 'complex'],
      [
        { tier: 'simple', fallback: false },
        { tier: 'simple', fallback: false },
        { tier: 'complex', fallback: true },
      ],
    );
    expect(r.cases).toBe(3);
    expect(r.correct).toBe(2);
    expect(r.accuracy).toBeCloseTo(2 / 3);
    expect(r.confusion.complex.simple).toBe(1);
    expect(r.confusion.simple.simple).toBe(1);
    expect(r.confusion.complex.complex).toBe(1);
    expect(r.fallbacks).toBe(1);
  });

  it('rejects mismatched lengths', () => {
    expect(() => scoreRouting(['simple'], [])).toThrow(/length/);
  });
});
