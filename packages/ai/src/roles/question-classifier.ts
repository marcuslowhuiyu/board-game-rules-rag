import { z } from 'zod';
import type { StructuredModel } from '../bedrock/converse-structured.js';
import type { ModelEntry } from '../models/catalog.js';
import type { ModelCallRecord } from '../models/telemetry.js';

export type QuestionTier = 'simple' | 'complex';

export const ROUTER_PROMPT_VERSION = 'router-v2';

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

If one rule in one place answers the question, choose simple, even if the question is long or mentions several game terms.

Example 1 (simple): "In Catan, can I trade resource cards with another player on their turn when I am not the active player?" The rule on trading answers it. {"tier": "simple"}
Example 2 (simple): "When I place a tile in Carcassonne next to a river tile, does the river have to keep turning in the same direction as the previous river tile?" The river placement rule answers it. {"tier": "simple"}
Example 3 (complex): "In Pandemic, if an outbreak happens in a city during the Infect Cities step and that triggers a chain reaction, how does that affect the infection rate marker and the cards I discard?" It needs the outbreak, infection and discard rules. {"tier": "complex"}
Example 4 (complex): "In Azul, if I fill a pattern line with a first-player tile on the floor and then score the wall at end of round, how are my points and penalties worked out?" It needs the wall tiling, floor line and scoring rules. {"tier": "complex"}

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
