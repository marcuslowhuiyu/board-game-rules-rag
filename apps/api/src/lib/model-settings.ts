import { MODEL_ROLES, type ModelCatalog, type ModelRole } from '@bgr/ai';
import type { ModelChoices, ModelSettingsRepository } from '@bgr/persistence';
import type { Logger } from '@bgr/shared';

export interface ModelChoiceCache {
  current(): Promise<ModelChoices>;
  /** Drops the cached value, so the next `current()` reads the repository (after a PUT). */
  invalidate(): void;
}

/**
 * The stored choices, read at most once per `ttlMs`. A failed read logs a warning and returns the
 * last good choices (or `{}`, i.e. catalog defaults); it does not refresh the timestamp, so the
 * next call retries.
 */
export function createModelChoiceCache(
  repo: ModelSettingsRepository,
  opts: { ttlMs: number; now?: () => number; logger: Logger },
): ModelChoiceCache {
  const now = opts.now ?? Date.now;
  let cached: { choices: ModelChoices; readAt: number } | undefined;
  let lastGood: ModelChoices | undefined;
  return {
    async current() {
      if (cached && now() - cached.readAt < opts.ttlMs) return cached.choices;
      try {
        const choices = await repo.getModelChoices();
        cached = { choices, readAt: now() };
        lastGood = choices;
        return choices;
      } catch (err) {
        opts.logger.warn('model settings read failed; using last known choices', {
          error: err instanceof Error ? err.message : String(err),
        });
        return lastGood ?? {};
      }
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
