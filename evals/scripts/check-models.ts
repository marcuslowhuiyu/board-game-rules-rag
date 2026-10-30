/**
 * Model availability check: one tiny paid call per catalog model, from the catalog's region.
 *
 *   pnpm -C evals models:check
 *
 * Exits non-zero when any model fails. Needs AWS credentials and the operator's OK (paid).
 */
import { ConverseStructuredModel, loadModelCatalog } from '@bgr/ai';
import { checkModels, exitCodeFor, formatRows } from '../src/live/check-models.js';

const rows = await checkModels(loadModelCatalog(), new ConverseStructuredModel());
process.stdout.write(formatRows(rows));
process.exitCode = exitCodeFor(rows);
