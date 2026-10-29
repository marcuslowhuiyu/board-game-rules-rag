import { z } from 'zod';
import type { StructuredModel } from '../bedrock/converse-structured.js';
import type { ModelEntry } from '../models/catalog.js';
import type { ModelCallRecord } from '../models/telemetry.js';

export type QuestionTier = 'simple' | 'complex';

export const ROUTER_PROMPT_VERSION = 'router-v1';

export interface QuestionClassifier {
  classify(
    question: string,
    correlationId?: string,
  ): Promise<{ tier: QuestionTier; record: ModelCallRecord }>;
}

const ClassificationSchema = z.object({ tier: z.enum(['simple', 'complex']) });

const CLASSIFICATION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { tier: { type: 'string', enum: ['simple', 'complex'] } },
  required: ['tier'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You classify questions about the rules of a board game.

Classify the question into exactly one tier:
- "simple": a single rule answers it.
- "complex": answering it needs two or more rules, often from different sections of the rulebook.

Respond only with JSON of the form {"tier": "simple"} or {"tier": "complex"}.`;

export function createQuestionClassifier(
  model: StructuredModel,
  entry: ModelEntry,
): QuestionClassifier {
  return {
    async classify(question, correlationId) {
      const { value, record } = await model.call({
        role: 'router',
        entry,
        promptVersion: ROUTER_PROMPT_VERSION,
        system: SYSTEM_PROMPT,
        user: `Question: ${question}`,
        schema: ClassificationSchema,
        jsonSchema: CLASSIFICATION_JSON_SCHEMA,
        schemaName: 'question_tier',
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      return { tier: value.tier, record };
    },
  };
}
