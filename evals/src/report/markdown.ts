import type { EvalReport } from '../scoring/aggregate.js';

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const num = (x: number) => x.toFixed(2);

/**
 * A compact table for PR discussion. The JSON report holds the full detail.
 * `label` names the index the run used (live, or a local re-embed).
 */
export function toMarkdown(report: EvalReport, label?: string): string {
  const { bars } = report.config;
  const lines = [
    `## Retrieval eval — ${label ? `${label} — ` : ''}${report.generatedAt}`,
    '',
    '| Game | Chunks | Cases | R@1 | R@3 | R@5 | MRR | Irrelevant | Simple pass | Complex full coverage |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...report.games
      .map((g) =>
        [
          g.smallCorpus ? `${g.game} (small corpus)` : g.game,
          g.chunks,
          g.cases,
          num(g.recallAt1),
          num(g.recallAt3),
          num(g.recallAt5),
          num(g.mrr),
          pct(g.irrelevantRate),
          pct(g.simplePassRate),
          pct(g.complexFullCoverageRate),
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
    '',
    '| Tier | Cases counted | Pass rate | Bar | Result |',
    '|---|---|---|---|---|',
    ...(['simple', 'complex'] as const).map((name) => {
      const t = report.tiers[name];
      const rule = name === 'simple' ? `top ${bars.simple.k}` : `all in top ${bars.complex.k}`;
      return `| ${name} (${rule}) | ${t.cases} | ${pct(t.passRate)} | ${pct(t.bar)} | ${t.passed ? '✅' : '❌'} |`;
    }),
  ];

  if (report.models && Object.keys(report.models).length > 0) {
    const models = Object.entries(report.models)
      .map(
        ([role, m]) => `${role} ${m.key} (${m.modelId}, ${report.promptVersions?.[role] ?? '?'})`,
      )
      .join('; ');
    lines.push('', `Models: ${models}`);
  }
  if (report.modelCost) {
    const c = report.modelCost;
    lines.push(
      `Model cost: $${c.usd.toFixed(4)} over ${c.calls} calls (${c.inputTokens} input, ${c.outputTokens} output tokens). Rerank fallbacks: ${report.rerankFallbacks}.`,
    );
  }
  if (report.cutShort) {
    lines.push(
      '',
      '⚠️ Cut short: the cost cap was reached; remaining cases were scored without model calls.',
    );
  }
  if (report.routing) {
    const r = report.routing;
    lines.push(
      '',
      `Routing accuracy: ${pct(r.accuracy)} (${r.correct}/${r.cases}; ${r.fallbacks} router fallbacks). Not gated.`,
      '',
      '| Expected / predicted | simple | complex |',
      '|---|---|---|',
      `| simple | ${r.confusion.simple.simple} | ${r.confusion.simple.complex} |`,
      `| complex | ${r.confusion.complex.simple} | ${r.confusion.complex.complex} |`,
    );
  }

  for (const name of ['simple', 'complex'] as const) {
    const k = bars[name].k;
    const failed = report.cases.filter((c) => c.tier === name && !c.fullCoverageAt[k]);
    if (failed.length === 0) continue;
    lines.push('', `Failed ${name} cases:`, failed.map((c) => `\`${c.id}\``).join(', '));
  }
  return lines.join('\n') + '\n';
}
