import { describe, expect, it } from 'vitest';
import { vectorSettingsFromEnv } from './stage-context.js';

const env = {
  EMBEDDING_REGION: 'ap-southeast-2',
  EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
  EMBEDDING_DIMENSIONS: '1024',
  EMBEDDING_CONCURRENCY: '8',
  VECTOR_REGION: 'ap-southeast-1',
  VECTOR_INDEX_ARN: 'arn:aws:s3vectors:ap-southeast-1:000000000000:bucket/b/index/i',
};

describe('vectorSettingsFromEnv', () => {
  it('reads the embedding model and vector index from the environment', () => {
    expect(vectorSettingsFromEnv(env)).toEqual({
      embedding: {
        region: 'ap-southeast-2',
        modelId: 'amazon.titan-embed-text-v2:0',
        dimensions: 1024,
        concurrency: 8,
      },
      index: { region: 'ap-southeast-1', indexArn: env.VECTOR_INDEX_ARN },
    });
  });

  it('defaults the concurrency when unset', () => {
    const { EMBEDDING_CONCURRENCY: _, ...rest } = env;
    expect(vectorSettingsFromEnv(rest).embedding.concurrency).toBe(4);
  });

  it.each(['EMBEDDING_REGION', 'EMBEDDING_MODEL_ID', 'VECTOR_INDEX_ARN'] as const)(
    'fails fast when %s is missing',
    (key) => {
      const { [key]: _, ...rest } = env;
      expect(() => vectorSettingsFromEnv(rest)).toThrow(`missing required env var: ${key}`);
    },
  );

  it('rejects a dimension Titan V2 does not support', () => {
    expect(() => vectorSettingsFromEnv({ ...env, EMBEDDING_DIMENSIONS: '768' })).toThrow(
      /EMBEDDING_DIMENSIONS must be one of 256, 512, 1024/,
    );
  });
});
