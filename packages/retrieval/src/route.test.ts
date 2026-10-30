import type { QuestionClassifier } from '@bgr/ai';
import type { Logger } from '@bgr/shared';
import { describe, expect, it, vi } from 'vitest';
import { evidenceLimit, routeQuestion } from './route.js';

describe('evidenceLimit', () => {
  it('maps tier to the configured keep-count', () => {
    const limits = { simple: 3, complex: 10 };
    expect(evidenceLimit('simple', limits)).toBe(3);
    expect(evidenceLimit('complex', limits)).toBe(10);
  });
});

describe('routeQuestion', () => {
  it("returns the classifier's tier", async () => {
    const classify = vi.fn().mockResolvedValue({ tier: 'simple', record: {} });
    const out = await routeQuestion('q', { classify } as unknown as QuestionClassifier, {
      correlationId: 'cid',
    });
    expect(out).toEqual({ tier: 'simple', fallback: false });
    expect(classify).toHaveBeenCalledWith('q', 'cid');
  });

  it('returns complex when the classifier throws', async () => {
    const classifier = {
      classify: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as QuestionClassifier;
    const warn = vi.fn();
    const out = await routeQuestion('q', classifier, {
      logger: { warn } as unknown as Logger,
      correlationId: 'cid',
    });
    expect(out).toEqual({ tier: 'complex', fallback: true, error: 'Error: boom' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('cid');
  });
});
