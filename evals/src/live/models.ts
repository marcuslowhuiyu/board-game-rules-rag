import {
  ConverseStructuredModel,
  RERANKER_PROMPT_VERSION,
  ROUTER_PROMPT_VERSION,
  createPassageRanker,
  createQuestionClassifier,
  loadModelCatalog,
  modelFor,
  type ModelCatalog,
  type PassageRanker,
  type QuestionClassifier,
} from '@bgr/ai';
import { CostMeter } from '../cost-meter.js';

export interface EvalModels {
  meter: CostMeter;
  ranker?: PassageRanker;
  classifier?: QuestionClassifier;
  /** role → key and modelId, for the report. */
  models: Record<string, { key: string; modelId: string }>;
  promptVersions: Record<string, string>;
}

/**
 * Wires the Bedrock-backed ranker and/or classifier to a cost meter. Nothing
 * is called here; the first Bedrock request happens when the eval runs.
 */
export function createEvalModels(options: {
  maxUsd: number;
  rerank: boolean;
  rerankKey?: string | undefined;
  route: boolean;
  catalog?: ModelCatalog;
}): EvalModels {
  const catalog = options.catalog ?? loadModelCatalog();
  const meter = new CostMeter(options.maxUsd);
  const model = new ConverseStructuredModel({ onCall: (r) => meter.record(r) });
  const out: EvalModels = { meter, models: {}, promptVersions: {} };
  if (options.rerank) {
    const entry = modelFor(catalog, 'reranker', options.rerankKey);
    out.ranker = createPassageRanker(model, entry);
    out.models['reranker'] = { key: entry.key, modelId: entry.modelId };
    out.promptVersions['reranker'] = RERANKER_PROMPT_VERSION;
  }
  if (options.route) {
    const entry = modelFor(catalog, 'router');
    out.classifier = createQuestionClassifier(model, entry);
    out.models['router'] = { key: entry.key, modelId: entry.modelId };
    out.promptVersions['router'] = ROUTER_PROMPT_VERSION;
  }
  return out;
}
