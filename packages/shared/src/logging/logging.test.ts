import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

const collectLines = (): { lines: string[]; sink: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
};

describe('createLogger', () => {
  it('emits structured JSON with level, time, msg, and provided fields', () => {
    const { lines, sink } = collectLines();
    const logger = createLogger({
      sink,
      now: () => new Date('2026-09-15T00:00:00.000Z'),
    });

    logger.info('hello', { requestId: 'abc' });

    expect(lines).toHaveLength(1);
    const first = lines[0];
    expect(first).toBeDefined();
    const parsed = JSON.parse(first as string) as Record<string, unknown>;
    expect(parsed).toEqual({
      level: 'info',
      time: '2026-09-15T00:00:00.000Z',
      msg: 'hello',
      requestId: 'abc',
    });
  });

  it('honors level thresholds', () => {
    const { lines, sink } = collectLines();
    const logger = createLogger({ level: 'warn', sink });

    logger.debug('nope');
    logger.info('also nope');
    logger.warn('yes');
    logger.error('yes');

    expect(lines).toHaveLength(2);
  });

  it('merges base bindings from child loggers', () => {
    const { lines, sink } = collectLines();
    const root = createLogger({ sink, base: { service: 'api' } });
    const child = root.child({ requestId: 'req-1' });

    child.info('handled');

    const first = lines[0];
    expect(first).toBeDefined();
    const parsed = JSON.parse(first as string) as Record<string, unknown>;
    expect(parsed.service).toBe('api');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.msg).toBe('handled');
  });
});
