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

Example 1 (simple): "In Catan, how many victory points does the Longest Road card give?" The Longest Road rule answers it. {"tier": "simple"}
Example 2 (simple): "In Carcassonne, when I place a river tile, am I allowed to make a U-turn with the river?" The river placement rule answers it. {"tier": "simple"}
Example 3 (complex): "In Carcassonne, if a road I complete has one of my meeples and one of another player's meeples on it, who scores it, and do we both get our meeples back?" It needs the tied majority scoring rule and the rule that completed features return their meeples. {"tier": "complex"}
Example 4 (complex): "In Pandemic, how many cards does each player start with in a three-player game, and how do I work out who goes first and whether we have won once the last disease is cured?" It needs the setup, turn order and winning rules. {"tier": "complex"}

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
