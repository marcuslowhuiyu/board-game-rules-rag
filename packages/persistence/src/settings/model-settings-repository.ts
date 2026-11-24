/** The roles whose model can be chosen. Same names as the `ModelRole` in `@bgr/ai`; persistence does not depend on that package. */
export type SettingsRole = 'router' | 'reranker' | 'answerer';

/** The stored model key per role; a role with no entry uses the catalog default. */
export type ModelChoices = Partial<Record<SettingsRole, string>>;

export interface ModelSettingsRepository {
  /** Strongly consistent read. */
  getModelChoices(): Promise<ModelChoices>;
  setModelChoice(role: SettingsRole, key: string, updatedAt: string): Promise<void>;
}

export const SETTINGS_ROLES: readonly SettingsRole[] = ['router', 'reranker', 'answerer'];

export function assertSettingsRole(role: string): asserts role is SettingsRole {
  if (!SETTINGS_ROLES.includes(role as SettingsRole)) {
    throw new Error(`invalid settings role: ${role}`);
  }
}
