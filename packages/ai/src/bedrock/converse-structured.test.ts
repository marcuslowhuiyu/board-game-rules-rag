import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { costUsd, type ModelEntry } from '../models/catalog.js';
import type { ModelCallRecord } from '../models/telemetry.js';
import {
  ConverseStructuredModel,
  ModelCallError,
  ModelOutputError,
  type StructuredRequest,
} from './converse-structured.js';

const bedrock = mockClient(BedrockRuntimeClient);

const entry = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  key: 'nova-micro',
  displayName: 'Nova Micro',
  modelId: 'apac.amazon.nova-micro-v1:0',
  region: 'ap-southeast-1',
  inputUsdPerMTok: 1,
  outputUsdPerMTok: 2,
  structuredOutput: 'native',
  maxTokens: 256,
  temperature: 0,
  additionalModelRequestFields: { foo: 'bar' },
  ...over,
});

const jsonEntry = (): ModelEntry => {
  const { additionalModelRequestFields: _omit, ...rest } = entry({ structuredOutput: 'json' });
  return rest;
};

const schema = z.object({ tier: z.enum(['simple', 'complex']) });
const jsonSchema = {
  type: 'object',
  properties: { tier: { type: 'string', enum: ['simple', 'complex'] } },
  required: ['tier'],
  additionalProperties: false,
};

const request = (over: Partial<StructuredRequest<{ tier: 'simple' | 'complex' }>> = {}) => ({
  role: 'router' as const,
  entry: entry(),
  promptVersion: 'router-v1',
  system: 'You route questions.',
  user: 'How do I win?',
  schema,
  jsonSchema,
  schemaName: 'route_question',
  correlationId: 'corr-1',
  ...over,
});

const reply = (text: string, inputTokens = 10, outputTokens = 5) =>
  ({
    output: { message: { role: 'assistant', content: [{ text }] } },
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  }) as never;

function setup() {
  const records: ModelCallRecord[] = [];
  const model = new ConverseStructuredModel({ onCall: (r) => records.push(r) });
  return { model, records };
}

describe('ConverseStructuredModel', () => {
  beforeEach(() => bedrock.reset());

  it('native mode sends outputConfig and returns the validated value', async () => {
    bedrock.on(ConverseCommand).resolves(reply('{"tier":"simple"}', 1000, 500));
    const { model, records } = setup();

    const result = await model.call(request());

    expect(result.value).toEqual({ tier: 'simple' });
    const input = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(input.modelId).toBe('apac.amazon.nova-micro-v1:0');
    expect(input.outputConfig?.textFormat).toEqual({
      type: 'json_schema',
      structure: { jsonSchema: { name: 'route_question', schema: JSON.stringify(jsonSchema) } },
    });
    expect(input.additionalModelRequestFields).toEqual({ foo: 'bar' });
    expect(input.inferenceConfig).toEqual({ maxTokens: 256, temperature: 0 });
    expect(input.system).toEqual([{ text: 'You route questions.' }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'router',
      modelKey: 'nova-micro',
      promptVersion: 'router-v1',
      correlationId: 'corr-1',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: (1000 * 1 + 500 * 2) / 1_000_000,
      attempts: 1,
      ok: true,
    });
    expect(result.record).toBe(records[0]);
  });

  it('records prompt-cache tokens and prices them', async () => {
    bedrock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: '{"tier":"simple"}' }] } },
      usage: {
        inputTokens: 2,
        outputTokens: 143,
        totalTokens: 5682,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 5537,
      },
    } as never);
    const { model, records } = setup();

    await model.call(request());

    expect(records[0]).toMatchObject({
      inputTokens: 2,
      outputTokens: 143,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 5537,
      costUsd: ((2 + 5537) * 1 + 143 * 2) / 1_000_000,
    });
  });

  it('records zero cache tokens when the response has none', async () => {
    bedrock.on(ConverseCommand).resolves(reply('{"tier":"simple"}'));
    const { model, records } = setup();
    await model.call(request());
    expect(records[0]).toMatchObject({ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  });

  it('omits temperature from inferenceConfig when the entry does not define it', async () => {
    bedrock.on(ConverseCommand).resolves(reply('{"tier":"simple"}'));
    const { model } = setup();
    const { temperature: _omit, ...noTemp } = entry();

    await model.call(request({ entry: noTemp }));

    const input = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(input.inferenceConfig).toEqual({ maxTokens: 256 });
    expect(input.inferenceConfig).not.toHaveProperty('temperature');
  });

  it('json mode extracts the JSON object from surrounding text', async () => {
    bedrock.on(ConverseCommand).resolves(reply('Sure! {"tier":"simple"} hope that helps'));
    const { model } = setup();

    const result = await model.call(
      request({
        entry: jsonEntry(),
      }),
    );

    expect(result.value).toEqual({ tier: 'simple' });
    const input = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(input.outputConfig).toBeUndefined();
    expect(input.additionalModelRequestFields).toBeUndefined();
    const system = input.system?.[0]?.text ?? '';
    expect(system).toContain('You route questions.');
    expect(system).toContain(JSON.stringify(jsonSchema));
  });

  it('retries once on schema-invalid output then succeeds', async () => {
    bedrock
      .on(ConverseCommand)
      .resolvesOnce(reply('{"tier":"medium"}', 10, 5))
      .resolvesOnce(reply('{"tier":"complex"}', 20, 7));
    const { model, records } = setup();

    const result = await model.call(request());

    expect(result.value).toEqual({ tier: 'complex' });
    expect(result.record.attempts).toBe(2);
    expect(result.record.inputTokens).toBe(30);
    expect(result.record.outputTokens).toBe(12);
    expect(records).toHaveLength(1);
  });

  it('throws ModelOutputError after two invalid outputs', async () => {
    bedrock.on(ConverseCommand).resolves(reply('I cannot answer that.'));
    const { model, records } = setup();

    const error = await model.call(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(2);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false, attempts: 2, inputTokens: 20 });
    expect((error as ModelOutputError).record).toBe(records[0]);
  });

  it('sums cache tokens across attempts and carries them on ModelOutputError.record', async () => {
    const withCache = (cacheReadInputTokens: number, cacheWriteInputTokens: number) =>
      ({
        output: { message: { role: 'assistant', content: [{ text: 'not json' }] } },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheReadInputTokens,
          cacheWriteInputTokens,
        },
      }) as never;
    bedrock.on(ConverseCommand).resolvesOnce(withCache(0, 100)).resolvesOnce(withCache(50, 0));
    const { model, records } = setup();

    const error = (await model.call(request()).catch((e: unknown) => e)) as ModelOutputError;

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.record).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 100,
      costUsd: costUsd(entry(), {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 50,
        cacheWriteInputTokens: 100,
      }),
    });
    expect(error.record.costUsd).toBeCloseTo((20 * 1 + 10 * 2 + 50 * 1 + 100 * 1) / 1e6, 12);
    expect(records[0]).toBe(error.record);
  });

  it('a ModelCallError after one billed invalid attempt keeps that attempt cache tokens', async () => {
    const failure = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
    bedrock
      .on(ConverseCommand)
      .resolvesOnce({
        output: { message: { role: 'assistant', content: [{ text: 'not json' }] } },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheReadInputTokens: 7,
          cacheWriteInputTokens: 100,
        },
      } as never)
      .rejects(failure);
    const { model } = setup();

    const error = (await model.call(request()).catch((e: unknown) => e)) as ModelCallError;

    expect(error).toBeInstanceOf(ModelCallError);
    expect(error.record).toMatchObject({
      attempts: 2,
      ok: false,
      inputTokens: 10,
      cacheReadInputTokens: 7,
      cacheWriteInputTokens: 100,
    });
    expect(error.record.costUsd).toBeCloseTo((10 * 1 + 5 * 2 + 7 * 1 + 100 * 1) / 1e6, 12);
  });

  it('wraps Bedrock failures in ModelCallError and still reports telemetry', async () => {
    const failure = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' });
    bedrock.on(ConverseCommand).rejects(failure);
    const { model, records } = setup();

    const error = await model.call(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).cause).toBe(failure);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false, attempts: 1 });
    expect(records[0]!.error).toContain('ThrottlingException');
  });

  it('caches one client per region', async () => {
    bedrock.on(ConverseCommand).resolves(reply('{"tier":"simple"}'));
    const regions: string[] = [];
    const model = new ConverseStructuredModel({
      clientFactory: (region) => {
        regions.push(region);
        return new BedrockRuntimeClient({ region });
      },
    });

    await model.call(request());
    await model.call(request());
    await model.call(request({ entry: entry({ region: 'us-east-1' }) }));

    expect(regions).toEqual(['ap-southeast-1', 'us-east-1']);
  });

  it('json mode skips brace text before the real object', async () => {
    bedrock.on(ConverseCommand).resolves(reply('{P3} is most relevant: {"tier":"complex"} done'));
    const { model } = setup();
    const result = await model.call(request({ entry: jsonEntry() }));
    expect(result.value).toEqual({ tier: 'complex' });
    expect(result.record.attempts).toBe(1);
  });

  it('json mode handles a brace inside a string value', async () => {
    const strSchema = z.object({ note: z.string() });
    bedrock.on(ConverseCommand).resolves(reply('x {"note":"a } b { c"} y'));
    const { model } = setup();
    const result = await model.call({
      ...request({ entry: jsonEntry() }),
      schema: strSchema,
    } as never);
    expect((result as { value: unknown }).value).toEqual({ note: 'a } b { c' });
  });

  it('json mode with no valid object retries then throws ModelOutputError', async () => {
    bedrock.on(ConverseCommand).resolves(reply('{P3} and {nothing} here'));
    const { model } = setup();
    const error = await model.call(request({ entry: jsonEntry() })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelOutputError);
    expect(bedrock.commandCalls(ConverseCommand)).toHaveLength(2);
  });

  it('a throwing telemetry sink does not change a success', async () => {
    bedrock.on(ConverseCommand).resolves(reply('{"tier":"simple"}'));
    const model = new ConverseStructuredModel({
      onCall: () => {
        throw new Error('sink down');
      },
    });
    const result = await model.call(request());
    expect(result.value).toEqual({ tier: 'simple' });
  });

  it('a throwing telemetry sink does not mask the Bedrock error', async () => {
    bedrock.on(ConverseCommand).rejects(new Error('nope'));
    const model = new ConverseStructuredModel({
      onCall: () => {
        throw new Error('sink down');
      },
    });
    const error = await model.call(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
  });

  it('a throwing telemetry sink does not mask ModelOutputError', async () => {
    bedrock.on(ConverseCommand).resolves(reply('nothing'));
    const model = new ConverseStructuredModel({
      onCall: () => {
        throw new Error('sink down');
      },
    });
    const error = await model.call(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelOutputError);
  });
});

describe('ConverseStructuredModel run deadline', () => {
  /** A client whose replies take `ms` on the injected clock; `hang` never answers. */
  function slowClient(clock: { t: number }, ms: number, text: string, hang = false) {
    const signals: AbortSignal[] = [];
    let sends = 0;
    const client = {
      send: (_c: unknown, options?: { abortSignal?: AbortSignal }) => {
        sends += 1;
        if (options?.abortSignal) signals.push(options.abortSignal);
        if (hang) {
          return new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        clock.t += ms;
        return Promise.resolve(reply(text, 100, 50));
      },
    };
    return { client, signals, sends: () => sends };
  }

  it('bounds the request timeout by the time left before the deadline', async () => {
    const clock = { t: 0 };
    const slow = slowClient(clock, 0, '', true);
    const records: ModelCallRecord[] = [];
    const model = new ConverseStructuredModel({
      onCall: (r) => records.push(r),
      requestTimeoutMs: 20_000,
      deadline: () => 50,
      now: () => clock.t,
      clientFactory: () => slow.client as never,
    });
    const started = Date.now();
    const err = await model.call(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(records).toHaveLength(1);
  });

  it('does not send when the deadline has passed, and still emits a record', async () => {
    const clock = { t: 1_000 };
    const slow = slowClient(clock, 0, '{"tier":"simple"}');
    const records: ModelCallRecord[] = [];
    const model = new ConverseStructuredModel({
      onCall: (r) => records.push(r),
      deadline: () => 1_000,
      now: () => clock.t,
      clientFactory: () => slow.client as never,
    });
    const err = await model.call(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect((err as ModelCallError).message).toMatch(/deadline/i);
    expect(slow.sends()).toBe(0);
    expect(records).toEqual([
      expect.objectContaining({
        ok: false,
        attempts: 0,
        costUsd: 0,
        error: expect.stringMatching(/deadline/i),
      }),
    ]);
  });

  it('skips the output retry when less time is left than the first attempt took', async () => {
    const clock = { t: 0 };
    // The first attempt takes 700 of the 1000 ms budget and returns invalid output.
    const slow = slowClient(clock, 700, 'not json');
    const records: ModelCallRecord[] = [];
    const model = new ConverseStructuredModel({
      onCall: (r) => records.push(r),
      deadline: () => 1_000,
      now: () => clock.t,
      clientFactory: () => slow.client as never,
    });
    const err = await model.call(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(slow.sends()).toBe(1);
    // The billed first attempt is still in the record.
    expect(records).toEqual([
      expect.objectContaining({ ok: false, attempts: 1, inputTokens: 100, outputTokens: 50 }),
    ]);
    expect(records[0]!.costUsd).toBeGreaterThan(0);
  });

  it('still retries invalid output when enough time is left', async () => {
    const clock = { t: 0 };
    const slow = slowClient(clock, 100, 'not json');
    const model = new ConverseStructuredModel({
      deadline: () => 1_000,
      now: () => clock.t,
      clientFactory: () => slow.client as never,
    });
    await expect(model.call(request())).rejects.toBeInstanceOf(ModelOutputError);
    expect(slow.sends()).toBe(2);
  });

  it('applies no deadline when the provider returns undefined', async () => {
    const clock = { t: 10_000_000 };
    const slow = slowClient(clock, 0, '{"tier":"simple"}');
    const model = new ConverseStructuredModel({
      deadline: () => undefined,
      now: () => clock.t,
      clientFactory: () => slow.client as never,
    });
    await expect(model.call(request())).resolves.toMatchObject({ value: { tier: 'simple' } });
  });
});
