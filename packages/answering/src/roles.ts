import {
  ANSWERER_PROMPT_VERSION,
  ConverseStructuredModel,
  RERANKER_PROMPT_VERSION,
  ROUTER_PROMPT_VERSION,
  createPassageRanker,
  createQuestionClassifier,
  createRulesAnswerer,
  modelFor,
  type ConverseStructuredOptions,
  type ModelCatalog,
  type ModelRole,
  type PassageRanker,
  type QuestionClassifier,
  type RulesAnswerer,
} from '@bgr/ai';
import { currentRunDeadline, recordModelCall } from './pipeline.js';

/** `@bgr/ai` names no separate type for the client factory; this is its option's type. */
export type ConverseClientFactory = NonNullable<ConverseStructuredOptions['clientFactory']>;

export interface AnswerRolesOptions {
  catalog: ModelCatalog;
  /** Catalog keys to use instead of the defaults; each must be approved for its role. */
  keys?: Partial<Record<ModelRole, string>>;
  requestTimeoutMs: number;
  rerankTopN: number;
  /** Tests inject a fake Bedrock client here. */
  clientFactory?: ConverseClientFactory;
}

export interface AnswerRoles {
  classifier: QuestionClassifier;
  ranker: PassageRanker;
  answerer: RulesAnswerer;
  /** The catalog entry that fills each role. */
  models: Record<ModelRole, { key: string; modelId: string }>;
  promptVersions: Record<ModelRole, string>;
}

/**
 * The router, reranker and answerer, built the one way the Lambda and the eval share: one model
 * whose calls reach the running pipeline's collector and deadline. An unapproved key throws here,
 * before any call is made.
 */
export function createAnswerRoles(opts: AnswerRolesOptions): AnswerRoles {
  const entries = {
    router: modelFor(opts.catalog, 'router', opts.keys?.router),
    reranker: modelFor(opts.catalog, 'reranker', opts.keys?.reranker),
    answerer: modelFor(opts.catalog, 'answerer', opts.keys?.answerer),
  };
  const model = new ConverseStructuredModel({
    onCall: recordModelCall,
    requestTimeoutMs: opts.requestTimeoutMs,
    // Both default to Date.now, the clock the pipeline sets the deadline on.
    deadline: currentRunDeadline,
    ...(opts.clientFactory ? { clientFactory: opts.clientFactory } : {}),
  });
  const summary = (role: ModelRole) => ({ key: entries[role].key, modelId: entries[role].modelId });
  return {
    classifier: createQuestionClassifier(model, entries.router),
    ranker: createPassageRanker(model, entries.reranker, { maxRanked: opts.rerankTopN }),
    answerer: createRulesAnswerer(model, entries.answerer),
    models: {
      router: summary('router'),
      reranker: summary('reranker'),
      answerer: summary('answerer'),
    },
    promptVersions: {
      router: ROUTER_PROMPT_VERSION,
      reranker: RERANKER_PROMPT_VERSION,
      answerer: ANSWERER_PROMPT_VERSION,
    },
  };
}
