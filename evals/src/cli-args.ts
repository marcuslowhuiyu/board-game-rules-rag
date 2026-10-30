/**
 * Model calls cost money, so `--rerank` and `--route` need an explicit cap.
 * Returns the cap in USD, or undefined when the run makes no model calls.
 */
export function checkModelFlags(values: {
  rerank?: boolean | string;
  route?: boolean;
  maxCost?: string;
}): number | undefined {
  const usesModels = values.rerank !== undefined || values.route === true;
  if (values.maxCost === undefined) {
    if (usesModels) throw new Error('--rerank and --route require --max-cost <usd>');
    return undefined;
  }
  const max = Number(values.maxCost);
  if (!Number.isFinite(max) || max < 0) {
    throw new Error(`--max-cost must be a non-negative number of USD; got "${values.maxCost}"`);
  }
  return max;
}
