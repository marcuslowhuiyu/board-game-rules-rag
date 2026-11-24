import { MODEL_ROLES, loadModelCatalog, type ModelRole } from '@bgr/ai';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { resolveModelKeys } from '../lib/model-settings.js';
import { errorResponse, ok } from '../lib/responses.js';
import { parseJsonBody, route, type RequestContext } from '../lib/router.js';

const PutSchema = z.object({ key: z.string().min(1) });

export interface ModelOptionView {
  key: string;
  displayName: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}
export interface RoleSettingView {
  role: ModelRole;
  chosen: string;
  default: string;
  options: ModelOptionView[];
}
export interface ModelSettingsView {
  roles: RoleSettingView[];
}

const validation = (message: string) => errorResponse(400, 'VALIDATION', message);

/**
 * GET /settings/models: each role's resolved choice (a stale stored key shows as the default),
 * the catalog default and the approved options.
 * PUT /settings/models/{role}: body `{ key }`; the role and key are validated against the catalog
 * before anything is stored, and the choice cache is invalidated afterwards.
 */
export function settingsRoutes(ctxFactory: () => AppContext) {
  const view = async (app: AppContext, rc: RequestContext): Promise<ModelSettingsView> => {
    const catalog = loadModelCatalog();
    const keys = resolveModelKeys(catalog, await app.modelChoices.current(), rc.logger);
    return {
      roles: MODEL_ROLES.map((role) => ({
        role,
        chosen: keys[role],
        default: catalog.defaults[role],
        options: catalog.approved[role].flatMap((key) => {
          const m = catalog.models[key];
          return m
            ? [
                {
                  key,
                  displayName: m.displayName,
                  inputUsdPerMTok: m.inputUsdPerMTok,
                  outputUsdPerMTok: m.outputUsdPerMTok,
                },
              ]
            : [];
        }),
      })),
    };
  };

  const getModels = async (rc: RequestContext) => ok(await view(ctxFactory(), rc));

  const putModel = async (rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const catalog = loadModelCatalog();
    const role = MODEL_ROLES.find((r) => r === params['role']);
    if (!role) return validation(`unknown role: ${params['role'] ?? ''}`);

    let raw: unknown;
    try {
      raw = parseJsonBody(rc.event);
    } catch {
      return validation('request body is not valid JSON');
    }
    const parsed = PutSchema.safeParse(raw);
    if (!parsed.success) return validation('body must be {"key": "<model key>"}');
    const { key } = parsed.data;
    if (!catalog.approved[role].includes(key) || !catalog.models[key]) {
      return validation(`model "${key}" is not approved for ${role}`);
    }

    await app.modelSettings.setModelChoice(role, key, app.clock.now().toISOString());
    app.modelChoices.invalidate();
    return ok(await view(app, rc));
  };

  return [
    route('GET', '/settings/models', getModels),
    route('PUT', '/settings/models/{role}', putModel),
  ];
}
