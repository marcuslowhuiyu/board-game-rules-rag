import type { CalibrationBand } from '../scoring/aggregate-answers.js';
import type { AnswerCaseRow, AnswerRunReport } from '../run-answer-eval.js';

const pct = (v: number) => `${Math.round(v * 100)} %`;
const band = (b: CalibrationBand) => (b.rate === null ? '—' : `${pct(b.rate)} (${b.cases})`);

function misroutes(r: AnswerRunReport): string {
  const { complexAsSimple, simpleAsComplex } = r.summary.misroutes;
  const cs =
    complexAsSimple.cases === 0
      ? '—'
      : `${complexAsSimple.cases} (evidence ${pct(complexAsSimple.evidenceRate)})`;
  const sc = simpleAsComplex.cases === 0 ? '—' : String(simpleAsComplex.cases);
  return `complex→simple ${cs}; simple→complex ${sc}`;
}

/** Why a case missed, or [] when it is right on every check. */
function misses(c: AnswerCaseRow): string[] {
  if (c.error !== undefined) return [`error (${c.error})`];
  return [
    ...(c.guess ? ['guess'] : []),
    ...(!c.certaintyOk && !c.guess ? ['certainty'] : []),
    ...(c.evidenceOk === false ? ['evidence'] : []),
    ...(c.authorityOk === false ? ['authority'] : []),
    ...(c.forbiddenHit !== null ? [`forbidden "${c.forbiddenHit}"`] : []),
    ...(c.disagreeOk === false ? ['sources disagree'] : []),
    ...(c.playerChoiceOk === false ? ['player choice'] : []),
  ];
}

/** Which cases ran, so a subset run is never mistaken for the whole dataset. */
function caseScope(r: AnswerRunReport | undefined): string {
  const { games, caseIds } = r?.filters ?? { games: null, caseIds: null };
  if (games === null && caseIds === null) return 'Cases: all answer cases';
  const flags = [
    ...(games === null ? [] : [`--games ${games.join(',')}`]),
    ...(caseIds === null ? [] : [`--cases ${caseIds.join(',')}`]),
  ];
  return `Cases: **subset**, ${flags.join(' ')}`;
}

/** A cut-short run never counts as clearing the marks, whatever its verdict says. */
const clears = (r: AnswerRunReport) => r.summary.verdict === 'pass' && !r.cutShort;

/** The answer eval's model comparison: one column per run. */
export function toAnswerMarkdown(reports: readonly AnswerRunReport[]): string {
  const bars = reports[0]?.bars;
  const name = (r: AnswerRunReport) => r.models.answerer.key;
  const row = (label: string, cell: (r: AnswerRunReport) => string) =>
    `| ${label} | ${reports.map(cell).join(' | ')} |`;

  const lines = [
    '## Answer eval',
    '',
    caseScope(reports[0]),
    '',
    `| | ${reports.map(name).join(' | ')} |`,
    `|---|${reports.map(() => '---').join('|')}|`,
    row(`guesses (bar ${bars?.maxGuesses ?? 0})`, (r) => String(r.summary.guesses)),
    row(`right passages (bar ${pct(bars?.minEvidenceRate ?? 0)})`, (r) =>
      pct(r.summary.evidenceRate),
    ),
    row(`right certainty (bar ${pct(bars?.minCertaintyRate ?? 0)})`, (r) =>
      pct(r.summary.certaintyRate),
    ),
    row('authority', (r) =>
      r.summary.authorityRate === null ? '—' : pct(r.summary.authorityRate),
    ),
    row('errors', (r) => String(r.summary.errors)),
    row('calibration (H/M/L)', (r) =>
      (['HIGH', 'MEDIUM', 'LOW'] as const).map((l) => band(r.summary.calibration[l])).join(' / '),
    ),
    row('misroutes', misroutes),
    row('$/question', (r) => `$${r.cost.perQuestionUsd.toFixed(4)}`),
    row('p50/p95 latency', (r) => `${r.cost.p50LatencyMs} / ${r.cost.p95LatencyMs} ms`),
    row('verdict', (r) => r.summary.verdict),
    '',
  ];

  const cheapest = reports
    .filter(clears)
    .reduce<AnswerRunReport | undefined>(
      (best, r) =>
        best === undefined || r.cost.perQuestionUsd < best.cost.perQuestionUsd ? r : best,
      undefined,
    );
  lines.push(
    `Cheapest model that clears every mark: ${cheapest ? `**${name(cheapest)}**` : 'none: operator decides'}`,
    '',
  );

  for (const r of reports.filter((x) => x.cutShort)) {
    lines.push(
      `> **Incomplete:** the ${name(r)} run was cut short by --max-cost after ${r.cases.length} cases; its scores do not count as clearing the marks.`,
      '',
    );
  }

  for (const r of reports) {
    const failed = r.cases
      .map((c) => ({ id: c.id, why: misses(c) }))
      .filter((c) => c.why.length > 0);
    lines.push(`### Failed cases: ${name(r)}`, '');
    if (failed.length === 0) lines.push('none');
    for (const c of failed) lines.push(`- ${c.id}: ${c.why.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}
