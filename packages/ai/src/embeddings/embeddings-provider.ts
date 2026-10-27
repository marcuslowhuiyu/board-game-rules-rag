export interface EmbeddingResult {
  /** One unit-normalised vector per input text, in input order. */
  vectors: number[][];
  /** Input tokens billed for the batch, for cost reporting. */
  inputTokens: number;
}

/**
 * Turns text into vectors (MASTER_PLAN §11). Business logic depends on this
 * interface, never on a model SDK; the model, region and dimension come from
 * configuration.
 */
export interface EmbeddingsProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}
