import {
  MODEL_ROLES,
  ModelCallError,
  ModelOutputError,
  type ModelCatalog,
  type ModelEntry,
  type ModelRole,
  type StructuredModel,
} from '@bgr/ai';
import { z } from 'zod';

export interface ModelCheckRow {
  key: string;
  modelId: string;
  ok: boolean;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

const PROMPT_VERSION = 'availability-check-v1';
const QUESTION = 'Question: Can a player trade resources on their own turn?';
const SCHEMA = z.object({ tier: z.enum(['simple', 'complex']) });
const JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { tier: { type: 'string', enum: ['simple', 'complex'] } },
  required: ['tier'],
  additionalProperties: false,
};

/** The first role the entry is approved for (router before reranker), if any. */
function roleOf(catalog: ModelCatalog, entry: ModelEntry): ModelRole | undefined {
  return MODEL_ROLES.find((role) => catalog.approved[role].includes(entry.key));
}

/**
 * One tiny router-style structured call per catalog entry, using the entry's own structured-output
 * mode. An entry approved for no role is reported as failed and not called.
 */
export async function checkModels(
  catalog: ModelCatalog,
  model: StructuredModel,
): Promise<ModelCheckRow[]> {
  const rows: ModelCheckRow[] = [];
  for (const entry of Object.values(catalog.models)) {
    const base = { key: entry.key, modelId: entry.modelId };
    const role = roleOf(catalog, entry);
    if (role === undefined) {
      rows.push({
        ...base,
        ok: false,
        latencyMs: 0,
        costUsd: 0,
        error: 'not approved for any role; not called',
      });
      continue;
    }
    try {
      const { record } = await model.call({
        role,
        entry,
        promptVersion: PROMPT_VERSION,
        system:
          'Classify the board game rules question as "simple" (one rule answers it) or "complex" (needs several rules). Respond only with JSON like {"tier": "simple"}.',
        user: QUESTION,
        schema: SCHEMA,
        jsonSchema: JSON_SCHEMA,
        schemaName: 'question_tier',
      });
      rows.push({ ...base, ok: true, latencyMs: record.latencyMs, costUsd: record.costUsd });
    } catch (err) {
      const record =
        err instanceof ModelCallError || err instanceof ModelOutputError ? err.record : undefined;
      rows.push({
        ...base,
        ok: false,
        latencyMs: record?.latencyMs ?? 0,
        costUsd: record?.costUsd ?? 0,
        error: record?.error ?? (err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return rows;
}

/** Non-zero when any model failed. */
export function exitCodeFor(rows: ModelCheckRow[]): number {
  return rows.every((r) => r.ok) ? 0 : 1;
}

export function formatRows(rows: ModelCheckRow[]): string {
  const lines = rows.map(
    (r) =>
      `${r.ok ? 'ok  ' : 'FAIL'}  ${r.key.padEnd(20)} ${r.modelId.padEnd(44)} ${String(r.latencyMs).padStart(6)} ms  $${r.costUsd.toFixed(6)}${r.error ? `  ${r.error}` : ''}`,
  );
  const total = rows.reduce((sum, r) => sum + r.costUsd, 0);
  return [...lines, `total cost: $${total.toFixed(6)}`].join('\n') + '\n';
}
