import { z } from 'zod';
// A static JSON import is inlined by esbuild, so it survives the Lambda bundle.
import bundledConfig from '../../models.config.json' with { type: 'json' };

export const MODEL_ROLES = ['router', 'reranker', 'answerer'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelEntry {
  key: string;
  displayName: string;
  modelId: string; // Bedrock model or inference-profile id
  region: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Prompt-cache read/write prices; each falls back to `inputUsdPerMTok` when unset. */
  cacheReadUsdPerMTok?: number;
  cacheWriteUsdPerMTok?: number;
  structuredOutput: 'native' | 'json';
  maxTokens: number;
  /** Output token limits for particular roles, overriding `maxTokens`; `modelFor` applies them. */
  roleMaxTokens?: Partial<Record<ModelRole, number>>;
  temperature?: number; // omitted for models that reject the field (e.g. GPT-6 Luna)
  additionalModelRequestFields?: Record<string, unknown>;
}

export interface ModelCatalog {
  models: Record<string, ModelEntry>;
  approved: Record<ModelRole, string[]>;
  defaults: Record<ModelRole, string>;
}

const ModelEntrySchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  modelId: z.string().min(1),
  region: z.string().min(1),
  inputUsdPerMTok: z.number().nonnegative(),
  outputUsdPerMTok: z.number().nonnegative(),
  cacheReadUsdPerMTok: z.number().nonnegative().optional(),
  cacheWriteUsdPerMTok: z.number().nonnegative().optional(),
  structuredOutput: z.enum(['native', 'json']),
  maxTokens: z.number().int().positive(),
  roleMaxTokens: z
    .strictObject({
      router: z.number().int().positive().optional(),
      reranker: z.number().int().positive().optional(),
      answerer: z.number().int().positive().optional(),
    })
    .optional(),
  temperature: z.number().min(0).optional(),
  additionalModelRequestFields: z.record(z.string(), z.unknown()).optional(),
});

const roleRecord = <T extends z.ZodType>(value: T) =>
  z.object({ router: value, reranker: value, answerer: value });

export const ModelCatalogSchema = z
  .object({
    models: z.record(z.string(), ModelEntrySchema),
    approved: roleRecord(z.array(z.string())),
    defaults: roleRecord(z.string()),
  })
  .superRefine((catalog, ctx) => {
    for (const [key, entry] of Object.entries(catalog.models)) {
      if (entry.key !== key) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', key, 'key'],
          message: `key must be "${key}"`,
        });
      }
    }
    for (const role of MODEL_ROLES) {
      for (const key of catalog.approved[role]) {
        if (!(key in catalog.models)) {
          ctx.addIssue({
            code: 'custom',
            path: ['approved', role],
            message: `approved model "${key}" has no entry in models`,
          });
        }
      }
      if (!catalog.approved[role].includes(catalog.defaults[role])) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaults', role],
          message: `default "${catalog.defaults[role]}" is not approved for ${role}`,
        });
      }
    }
  }) as unknown as z.ZodType<ModelCatalog>;

export function loadModelCatalog(raw: unknown = bundledConfig): ModelCatalog {
  return ModelCatalogSchema.parse(raw);
}

/** The entry approved for `role`, with that role's `roleMaxTokens` override applied. */
export function modelFor(catalog: ModelCatalog, role: ModelRole, key?: string): ModelEntry {
  const chosen = key ?? catalog.defaults[role];
  if (!catalog.approved[role].includes(chosen)) {
    throw new Error(`Model "${chosen}" is not approved for ${role}`);
  }
  const entry = catalog.models[chosen];
  if (!entry) throw new Error(`Model "${chosen}" has no catalog entry`);
  const maxTokens = entry.roleMaxTokens?.[role];
  return maxTokens === undefined ? entry : { ...entry, maxTokens };
}

/**
 * Cost of one call. Cache tokens are charged at the entry's cache prices, or at the input price
 * when those are unset (conservative: a cost cap never under-counts).
 */
export function costUsd(
  entry: ModelEntry,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
  },
): number {
  const cacheRead = entry.cacheReadUsdPerMTok ?? entry.inputUsdPerMTok;
  const cacheWrite = entry.cacheWriteUsdPerMTok ?? entry.inputUsdPerMTok;
  return (
    (usage.inputTokens * entry.inputUsdPerMTok +
      usage.outputTokens * entry.outputUsdPerMTok +
      usage.cacheReadInputTokens * cacheRead +
      usage.cacheWriteInputTokens * cacheWrite) /
    1_000_000
  );
}
