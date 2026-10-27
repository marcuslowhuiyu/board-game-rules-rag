import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { EmbeddingResult, EmbeddingsProvider } from './embeddings-provider.js';

/** Output sizes Titan Text Embeddings V2 supports. */
export const TITAN_V2_DIMENSIONS = [256, 512, 1024] as const;
export type TitanDimensions = (typeof TITAN_V2_DIMENSIONS)[number];

/** Titan V2 accepts up to 8,192 tokens or 50,000 characters per request. */
const MAX_INPUT_CHARS = 50_000;

export interface TitanEmbeddingsOptions {
  /** Bedrock region. Titan V2 is not offered in every region (ADR-0002). */
  region: string;
  modelId: string;
  dimensions: TitanDimensions;
  /**
   * Requests in flight at once. Titan V2 has no batch request on the
   * on-demand API, so a batch is one InvokeModel per text, bounded here to
   * stay under the account's requests-per-minute quota. Defaults to 4.
   */
  concurrency?: number;
  /** Throttling retries are the SDK's job. Defaults to 5 attempts. */
  maxAttempts?: number;
}

/** `EmbeddingsProvider` backed by Amazon Titan Text Embeddings V2 on Bedrock. */
export class TitanEmbeddingsProvider implements EmbeddingsProvider {
  readonly modelId: string;
  readonly dimensions: TitanDimensions;
  private readonly concurrency: number;
  private readonly client: BedrockRuntimeClient;

  constructor(options: TitanEmbeddingsOptions) {
    if (!TITAN_V2_DIMENSIONS.includes(options.dimensions)) {
      throw new Error(
        `Titan V2 dimensions must be one of ${TITAN_V2_DIMENSIONS.join(', ')}; got ${options.dimensions}`,
      );
    }
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.client = new BedrockRuntimeClient({
      region: options.region,
      maxAttempts: options.maxAttempts ?? 5,
    });
  }

  /** The Bedrock region requests go to. */
  region(): Promise<string> {
    return this.client.config.region();
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    texts.forEach((text, i) => {
      if (text.trim().length === 0) throw new Error(`text ${i} is empty`);
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`text ${i} exceeds ${MAX_INPUT_CHARS} characters (${text.length})`);
      }
    });

    const vectors: number[][] = new Array(texts.length);
    let inputTokens = 0;
    let next = 0;
    // After a failure no worker starts another (billable) request, and the
    // batch rejects only once the requests already sent have settled, so a
    // caller's retry never overlaps abandoned work.
    let failed = false;
    const worker = async () => {
      while (!failed && next < texts.length) {
        const i = next++;
        try {
          const out = await this.embedOne(texts[i]!);
          vectors[i] = out.embedding;
          inputTokens += out.inputTextTokenCount;
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(this.concurrency, texts.length) }, () => worker()),
    );
    const rejection = results.find((r) => r.status === 'rejected');
    if (rejection) throw rejection.reason;
    return { vectors, inputTokens };
  }

  private async embedOne(
    inputText: string,
  ): Promise<{ embedding: number[]; inputTextTokenCount: number }> {
    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(
          JSON.stringify({ inputText, dimensions: this.dimensions, normalize: true }),
        ),
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      embedding?: unknown;
      inputTextTokenCount?: unknown;
    };
    const embedding = parsed.embedding;
    if (!Array.isArray(embedding) || !embedding.every((x) => typeof x === 'number')) {
      throw new Error('Titan response has no numeric embedding');
    }
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `Titan response: expected ${this.dimensions} dimensions, got ${embedding.length}`,
      );
    }
    const tokens = parsed.inputTextTokenCount;
    return { embedding, inputTextTokenCount: typeof tokens === 'number' ? tokens : 0 };
  }
}
