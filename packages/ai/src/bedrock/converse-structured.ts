import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { z } from 'zod';
import { costUsd, type ModelEntry, type ModelRole } from '../models/catalog.js';
import type { ModelCallRecord, ModelCallSink } from '../models/telemetry.js';

export interface StructuredRequest<T> {
  role: ModelRole;
  entry: ModelEntry;
  promptVersion: string;
  system: string;
  user: string;
  /** Validation, always applied whatever the model claims. */
  schema: z.ZodType<T>;
  /** Sent to the model (native) or described in the prompt (json); must set additionalProperties: false. */
  jsonSchema: Record<string, unknown>;
  /** e.g. 'route_question'. */
  schemaName: string;
  correlationId?: string;
}

export interface StructuredResult<T> {
  value: T;
  record: ModelCallRecord;
}

export interface StructuredModel {
  call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** The model answered, but not with output that passes the schema, even after one retry. */
export class ModelOutputError extends Error {
  readonly record: ModelCallRecord;
  constructor(message: string, record: ModelCallRecord) {
    super(message);
    this.name = 'ModelOutputError';
    this.record = record;
  }
}

/** Bedrock itself failed (throttling, access, timeout, ...). */
export class ModelCallError extends Error {
  readonly record: ModelCallRecord;
  override readonly cause: unknown;
  constructor(message: string, record: ModelCallRecord, cause: unknown) {
    super(message);
    this.name = 'ModelCallError';
    this.record = record;
    this.cause = cause;
  }
}

export interface ConverseStructuredOptions {
  onCall?: ModelCallSink;
  /** SDK retries for transient failures. Defaults to 3. */
  maxAttempts?: number;
  /** Per-request timeout. Defaults to 120_000. */
  requestTimeoutMs?: number;
  clientFactory?: (region: string) => BedrockRuntimeClient;
}

const OUTPUT_ATTEMPTS = 2; // the first try plus one retry on invalid output

/** Structured Converse calls: Bedrock in, Zod-validated value out, one telemetry record per call. */
export class ConverseStructuredModel implements StructuredModel {
  private readonly clients = new Map<string, BedrockRuntimeClient>();
  private readonly onCall: ModelCallSink | undefined;
  private readonly requestTimeoutMs: number;
  private readonly clientFactory: (region: string) => BedrockRuntimeClient;

  constructor(options: ConverseStructuredOptions = {}) {
    this.onCall = options.onCall;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    const maxAttempts = options.maxAttempts ?? 3;
    this.clientFactory =
      options.clientFactory ?? ((region) => new BedrockRuntimeClient({ region, maxAttempts }));
  }

  async call<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const input = buildInput(req);
    const started = performance.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let attempts = 0;
    let lastIssue = '';

    const record = (ok: boolean, error?: string): ModelCallRecord => {
      const usage = { inputTokens, outputTokens };
      const rec: ModelCallRecord = {
        role: req.role,
        modelKey: req.entry.key,
        modelId: req.entry.modelId,
        promptVersion: req.promptVersion,
        ...(req.correlationId === undefined ? {} : { correlationId: req.correlationId }),
        ...usage,
        latencyMs: Math.round(performance.now() - started),
        costUsd: costUsd(req.entry, usage),
        attempts,
        ok,
        ...(error === undefined ? {} : { error }),
      };
      this.onCall?.(rec);
      return rec;
    };

    while (attempts < OUTPUT_ATTEMPTS) {
      attempts += 1;
      let output: ConverseCommandOutput;
      try {
        output = await this.client(req.entry.region).send(new ConverseCommand(input), {
          abortSignal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : 'Error';
        const message = cause instanceof Error ? cause.message : String(cause);
        const error = `${name}: ${message}`;
        throw new ModelCallError(`Bedrock call failed: ${error}`, record(false, error), cause);
      }
      inputTokens += output.usage?.inputTokens ?? 0;
      outputTokens += output.usage?.outputTokens ?? 0;

      const parsed = parseOutput(req, textOf(output));
      if (parsed.ok) return { value: parsed.value, record: record(true) };
      lastIssue = parsed.issue;
    }

    const error = `invalid model output after ${attempts} attempts: ${lastIssue}`;
    throw new ModelOutputError(error, record(false, error));
  }

  private client(region: string): BedrockRuntimeClient {
    let client = this.clients.get(region);
    if (!client) {
      client = this.clientFactory(region);
      this.clients.set(region, client);
    }
    return client;
  }
}

function buildInput<T>(req: StructuredRequest<T>): ConverseCommandInput {
  const { entry } = req;
  const native = entry.structuredOutput === 'native';
  const system = native
    ? req.system
    : `${req.system}\n\nAnswer with only a single JSON object, no other text, that matches this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`;
  return {
    modelId: entry.modelId,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: req.user }] }],
    inferenceConfig: { maxTokens: entry.maxTokens, temperature: entry.temperature },
    ...(native
      ? {
          outputConfig: {
            textFormat: {
              type: 'json_schema',
              structure: {
                jsonSchema: { name: req.schemaName, schema: JSON.stringify(req.jsonSchema) },
              },
            },
          },
        }
      : {}),
    ...(entry.additionalModelRequestFields
      ? { additionalModelRequestFields: entry.additionalModelRequestFields as never }
      : {}),
  };
}

function textOf(output: ConverseCommandOutput): string {
  return (output.output?.message?.content ?? []).map((block) => block.text ?? '').join('');
}

type Parsed<T> = { ok: true; value: T } | { ok: false; issue: string };

function parseOutput<T>(req: StructuredRequest<T>, text: string): Parsed<T> {
  const candidate = req.entry.structuredOutput === 'json' ? firstJsonObject(text) : text.trim();
  if (candidate === undefined) return { ok: false, issue: 'no JSON object in the response' };
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return { ok: false, issue: 'response is not valid JSON' };
  }
  const result = req.schema.safeParse(json);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issue: result.error.issues.map((i) => i.message).join('; ') };
}

/** The first balanced `{...}` in the text, string-literal aware. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}
