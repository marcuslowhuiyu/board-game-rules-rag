import { MODEL_ROLES, type ModelCatalog, type ModelRole } from '@bgr/ai';
import type { ModelChoices, ModelSettingsRepository } from '@bgr/persistence';
import type { Logger } from '@bgr/shared';

export interface ModelChoiceCache {
  current(): Promise<ModelChoices>;
  /** Drops the cached value, so the next `current()` reads the repository (after a PUT). */
  invalidate(): void;
}

/** The stored choices, read at most once per `ttlMs`. A failed read is not cached. */
export function createModelChoiceCache(
  repo: ModelSettingsRepository,
  opts: { ttlMs: number; now?: () => number },
): ModelChoiceCache {
  const now = opts.now ?? Date.now;
  let cached: { choices: ModelChoices; readAt: number } | undefined;
  return {
    async current() {
      if (cached && now() - cached.readAt < opts.ttlMs) return cached.choices;
      const choices = await repo.getModelChoices();
      cached = { choices, readAt: now() };
      return choices;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/**
 * The catalog key to use for each role. A role with no stored choice, or whose stored key the
 * catalog no longer approves, gets the catalog default; the latter is logged as a warning.
 */
export function resolveModelKeys(
  catalog: ModelCatalog,
  choices: ModelChoices,
  logger: Logger,
): Record<ModelRole, string> {
  const keys = { ...catalog.defaults };
  for (const role of MODEL_ROLES) {
    const stored = choices[role];
    if (stored === undefined) continue;
    if (catalog.approved[role].includes(stored) && catalog.models[stored]) {
      keys[role] = stored;
    } else {
      logger.warn('stored model choice is not approved; using the catalog default', {
        role,
        key: stored,
        default: catalog.defaults[role],
      });
    }
  }
  return keys;
}
