import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { PutVectorsCommand, QueryVectorsCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { S3VectorIndex } from './s3-vector-index.js';
import type { ChunkVectorMetadata } from './vector-index.js';

const s3v = mockClient(S3VectorsClient);

const options = { region: 'ap-southeast-1', vectorBucketName: 'bgr-vectors', indexName: 'chunks' };

const meta: ChunkVectorMetadata = {
  gameId: 'g_1',
  editionId: 'e_1',
  contentId: 'c_base',
  documentId: 'doc_1',
  authority: 'OFFICIAL_RULES',
  sourceType: 'RULEBOOK',
  headingPath: ['Setup', 'Trains'],
  pageStart: 2,
  pageEnd: 3,
  text: 'Each player takes 45 trains.',
};

describe('S3VectorIndex', () => {
  beforeEach(() => s3v.reset());

  it('queries with a pre-filter on game, edition and current documents, and maps distance to a score', async () => {
    s3v.on(QueryVectorsCommand).resolves({
      vectors: [{ key: 'ch_1', distance: 0.25, metadata: meta as never }],
      distanceMetric: 'cosine',
    });
    const index = new S3VectorIndex(options);

    const hits = await index.query({
      vector: [0.1, 0.2],
      topK: 12,
      filter: { gameId: 'g_1', editionId: 'e_1', documentIds: ['doc_1', 'doc_2'] },
    });

    expect(hits).toEqual([{ key: 'ch_1', score: 0.75, metadata: meta }]);
    const input = s3v.commandCalls(QueryVectorsCommand)[0]!.args[0].input;
    expect(input).toEqual({
      vectorBucketName: 'bgr-vectors',
      indexName: 'chunks',
      topK: 12,
      queryVector: { float32: [0.1, 0.2] },
      queryMode: 'ENHANCED',
      returnMetadata: true,
      returnDistance: true,
      filter: {
        $and: [
          { gameId: { $eq: 'g_1' } },
          { editionId: { $eq: 'e_1' } },
          { documentId: { $in: ['doc_1', 'doc_2'] } },
        ],
      },
    });
  });

  it('rejects a filter over the 100-constraint query limit instead of sending it', async () => {
    const index = new S3VectorIndex(options);
    const documentIds = Array.from({ length: 99 }, (_, i) => `doc_${i}`);
    await expect(
      index.query({ vector: [1], topK: 5, filter: { gameId: 'g', editionId: 'e', documentIds } }),
    ).rejects.toThrow(/101 filter constraints; the limit is 100/);
    expect(s3v.commandCalls(QueryVectorsCommand)).toHaveLength(0);
  });

  it('rejects a topK above one result page', async () => {
    const index = new S3VectorIndex(options);
    await expect(
      index.query({
        vector: [1],
        topK: 101,
        filter: { gameId: 'g', editionId: 'e', documentIds: ['d'] },
      }),
    ).rejects.toThrow(/topK must be between 1 and 100/);
  });

  it('fails on a result whose metadata is malformed', async () => {
    s3v.on(QueryVectorsCommand).resolves({
      vectors: [{ key: 'ch_1', distance: 0.1, metadata: { gameId: 'g_1' } as never }],
      distanceMetric: 'cosine',
    });
    const index = new S3VectorIndex(options);
    await expect(
      index.query({
        vector: [1],
        topK: 5,
        filter: { gameId: 'g_1', editionId: 'e_1', documentIds: ['doc_1'] },
      }),
    ).rejects.toThrow(/vector ch_1 has invalid metadata/);
  });

  it('omits undefined metadata fields, which the service cannot store', async () => {
    s3v.on(PutVectorsCommand).resolves({});
    const index = new S3VectorIndex(options);

    await index.putVectors([
      { key: 'ch_1', vector: [1], metadata: { ...meta, documentVersion: undefined } },
    ]);

    const sent = s3v.commandCalls(PutVectorsCommand)[0]!.args[0].input.vectors![0]!.metadata;
    expect(Object.keys(sent as object)).not.toContain('documentVersion');
  });

  it('writes vectors in batches of at most 500', async () => {
    s3v.on(PutVectorsCommand).resolves({});
    const index = new S3VectorIndex(options);
    const items = Array.from({ length: 1001 }, (_, i) => ({
      key: `ch_${i}`,
      vector: [i, 1],
      metadata: meta,
    }));

    await index.putVectors(items);

    const calls = s3v.commandCalls(PutVectorsCommand).map((c) => c.args[0].input);
    expect(calls.map((c) => c.vectors?.length)).toEqual([500, 500, 1]);
    expect(calls[0]).toMatchObject({ vectorBucketName: 'bgr-vectors', indexName: 'chunks' });
    expect(calls[2]!.vectors![0]).toEqual({
      key: 'ch_1000',
      data: { float32: [1000, 1] },
      metadata: meta,
    });
  });
});
