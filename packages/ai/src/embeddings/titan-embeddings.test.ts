import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { TitanEmbeddingsProvider } from './titan-embeddings.js';

const bedrock = mockClient(BedrockRuntimeClient);

const base = {
  region: 'ap-southeast-2',
  modelId: 'amazon.titan-embed-text-v2:0',
  dimensions: 1024,
} as const;

/** A Titan V2 response whose vector encodes the input text's length, so tests can match outputs to inputs. */
function titanResponse(input: InvokeModelCommandInput, dimensions = 4) {
  const body = JSON.parse(new TextDecoder().decode(input.body as Uint8Array)) as {
    inputText: string;
  };
  const embedding = Array.from({ length: dimensions }, (_, i) => body.inputText.length + i);
  return {
    body: new TextEncoder().encode(
      JSON.stringify({ embedding, inputTextTokenCount: body.inputText.split(' ').length }),
    ),
  } as never;
}

function sentBodies(): { inputText: string; dimensions: number; normalize: boolean }[] {
  return bedrock
    .commandCalls(InvokeModelCommand)
    .map((c) => JSON.parse(new TextDecoder().decode(c.args[0].input.body as Uint8Array)));
}

describe('TitanEmbeddingsProvider', () => {
  beforeEach(() => bedrock.reset());

  it('embeds each text with Titan V2 at the configured dimension, normalised, in input order', async () => {
    bedrock.on(InvokeModelCommand).callsFake((input) => titanResponse(input, 512));
    const provider = new TitanEmbeddingsProvider({ ...base, dimensions: 512 });

    const result = await provider.embed(['roll two dice', 'draw a card now']);

    expect(result.vectors.map((v) => v.slice(0, 2))).toEqual([
      [13, 14],
      [15, 16],
    ]);
    expect(result.vectors[0]).toHaveLength(512);
    expect(result.inputTokens).toBe(3 + 4);
    const calls = bedrock.commandCalls(InvokeModelCommand);
    expect(calls[0]!.args[0].input).toMatchObject({
      modelId: 'amazon.titan-embed-text-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
    });
    expect(sentBodies()).toEqual([
      { inputText: 'roll two dice', dimensions: 512, normalize: true },
      { inputText: 'draw a card now', dimensions: 512, normalize: true },
    ]);
  });

  it('calls Bedrock in the configured region with the configured model', async () => {
    const provider = new TitanEmbeddingsProvider(base);
    expect(await provider.region()).toBe('ap-southeast-2');
    expect(provider.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(provider.dimensions).toBe(1024);
  });

  it('keeps at most `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    bedrock.on(InvokeModelCommand).callsFake(async (input) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return titanResponse(input, 256);
    });
    const provider = new TitanEmbeddingsProvider({ ...base, dimensions: 256, concurrency: 3 });

    const texts = Array.from({ length: 10 }, (_, i) => 'x'.repeat(i + 1));
    const result = await provider.embed(texts);

    expect(peak).toBe(3);
    expect(result.vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));
  });

  it('returns no vectors and makes no calls for an empty batch', async () => {
    const provider = new TitanEmbeddingsProvider(base);
    expect(await provider.embed([])).toEqual({ vectors: [], inputTokens: 0 });
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it('rejects dimensions Titan V2 does not support', () => {
    expect(() => new TitanEmbeddingsProvider({ ...base, dimensions: 768 as never })).toThrow(
      /dimensions must be one of 256, 512, 1024/,
    );
  });

  it('rejects blank text before calling Bedrock', async () => {
    const provider = new TitanEmbeddingsProvider(base);
    await expect(provider.embed(['ok', '   '])).rejects.toThrow(/text 1 is empty/);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it('rejects text over the Titan V2 input limit before calling Bedrock', async () => {
    const provider = new TitanEmbeddingsProvider(base);
    await expect(provider.embed(['a'.repeat(50_001)])).rejects.toThrow(/exceeds 50000 characters/);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(0);
  });

  it('fails when Bedrock returns a vector of the wrong size', async () => {
    bedrock.on(InvokeModelCommand).callsFake((input) => titanResponse(input, 3));
    const provider = new TitanEmbeddingsProvider({ ...base, dimensions: 256 });
    await expect(provider.embed(['roll'])).rejects.toThrow(/expected 256 dimensions, got 3/);
  });

  it('stops sending requests after one fails, and rejects only once in-flight requests settle', async () => {
    let inFlight = 0;
    bedrock.on(InvokeModelCommand).callsFake(async (input) => {
      const first = bedrock.commandCalls(InvokeModelCommand).length === 1;
      inFlight++;
      await new Promise((r) => setTimeout(r, first ? 1 : 10));
      inFlight--;
      if (first) throw new Error('ThrottlingException');
      return titanResponse(input, 256);
    });
    const provider = new TitanEmbeddingsProvider({ ...base, dimensions: 256, concurrency: 3 });

    const texts = Array.from({ length: 12 }, (_, i) => `text ${i}`);
    await expect(provider.embed(texts)).rejects.toThrow('ThrottlingException');

    expect(inFlight).toBe(0);
    expect(bedrock.commandCalls(InvokeModelCommand)).toHaveLength(3);
  });

  it('propagates Bedrock errors', async () => {
    bedrock.on(InvokeModelCommand).rejects(new Error('AccessDeniedException'));
    const provider = new TitanEmbeddingsProvider(base);
    await expect(provider.embed(['roll'])).rejects.toThrow('AccessDeniedException');
  });
});
