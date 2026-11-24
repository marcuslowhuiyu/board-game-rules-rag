import {
  assertSettingsRole,
  type ModelChoices,
  type ModelSettingsRepository,
  type SettingsRole,
} from './model-settings-repository.js';

export class InMemoryModelSettingsRepository implements ModelSettingsRepository {
  private choices: ModelChoices = {};

  async getModelChoices(): Promise<ModelChoices> {
    return { ...this.choices };
  }

  async setModelChoice(role: SettingsRole, key: string, _updatedAt: string): Promise<void> {
    assertSettingsRole(role);
    this.choices = { ...this.choices, [role]: key };
  }
}
