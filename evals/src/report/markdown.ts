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

  for (const name of ['simple', 'complex'] as const) {
    const k = bars[name].k;
    const failed = report.cases.filter((c) => c.tier === name && !c.fullCoverageAt[k]);
    if (failed.length === 0) continue;
    lines.push('', `Failed ${name} cases:`, failed.map((c) => `\`${c.id}\``).join(', '));
  }
  return lines.join('\n') + '\n';
}
