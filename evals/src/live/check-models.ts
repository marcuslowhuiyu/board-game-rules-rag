import {
  MODEL_ROLES,
  ModelCallError,
  ModelOutputError,
  createPassageRanker,
  createQuestionClassifier,
  createRulesAnswerer,
  type ModelCallRecord,
  type ModelCatalog,
  type ModelEntry,
  type ModelRole,
  type StructuredModel,
} from '@bgr/ai';

export interface ModelCheckRow {
  key: string;
  modelId: string;
  /** null when the entry is approved for no role and was not called. */
  role: ModelRole | null;
  ok: boolean;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

const QUESTION = 'Can a player trade resources on their own turn?';
const PASSAGE = {
  id: 'check-passage',
  text: 'On your turn you may trade resources with the bank at 2:1.',
  headingPath: ['Trading'],
};

/** One call through the role's own code, so the request carries that role's real schema. */
function callRole(model: StructuredModel, entry: ModelEntry, role: ModelRole): Promise<unknown> {
  switch (role) {
    case 'router':
      return createQuestionClassifier(model, entry).classify(QUESTION);
    case 'reranker':
      return createPassageRanker(model, entry, { maxRanked: 1 }).rank(QUESTION, [PASSAGE]);
    case 'answerer':
      return createRulesAnswerer(model, entry).answer(QUESTION, [
        { ...PASSAGE, tier: 'OFFICIAL', sourceType: 'RULEBOOK', title: 'Rulebook' },
      ]);
  }
}

/**
 * One tiny structured call per catalog entry and approved role, made through the role itself so
 * the model gets that role's real schema and prompt: a schema the model rejects fails here, not
 * in the paid comparison. An entry approved for no role is reported as failed and not called.
 */
export async function checkModels(
  catalog: ModelCatalog,
  model: StructuredModel,
): Promise<ModelCheckRow[]> {
  const rows: ModelCheckRow[] = [];
  for (const entry of Object.values(catalog.models)) {
    const base = { key: entry.key, modelId: entry.modelId };
    const roles = MODEL_ROLES.filter((role) => catalog.approved[role].includes(entry.key));
    if (roles.length === 0) {
      rows.push({
        ...base,
        role: null,
        ok: false,
        latencyMs: 0,
        costUsd: 0,
        error: 'not approved for any role; not called',
      });
      continue;
    }
    for (const role of roles) {
      // The role's result hides its record, so take it from the call itself.
      let last: ModelCallRecord | undefined;
      const recording: StructuredModel = {
        call: async (req) => {
          const result = await model.call(req);
          last = result.record;
          return result;
        },
      };
      try {
        await callRole(recording, entry, role);
        rows.push({
          ...base,
          role,
          ok: true,
          latencyMs: last?.latencyMs ?? 0,
          costUsd: last?.costUsd ?? 0,
        });
      } catch (err) {
        const record =
          err instanceof ModelCallError || err instanceof ModelOutputError ? err.record : undefined;
        rows.push({
          ...base,
          role,
          ok: false,
          latencyMs: record?.latencyMs ?? 0,
          costUsd: record?.costUsd ?? 0,
          error: record?.error ?? (err instanceof Error ? err.message : String(err)),
        });
      }
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
      `${r.ok ? 'ok  ' : 'FAIL'}  ${r.key.padEnd(20)} ${(r.role ?? '-').padEnd(8)} ${r.modelId.padEnd(44)} ${String(r.latencyMs).padStart(6)} ms  $${r.costUsd.toFixed(6)}${r.error ? `  ${r.error}` : ''}`,
  );
  const total = rows.reduce((sum, r) => sum + r.costUsd, 0);
  return [...lines, `total cost: $${total.toFixed(6)}`].join('\n') + '\n';
}
