/**
 * PR subset of the answer eval: the real answer pipeline (`createAnswerPipeline` and
 * `createAnswerRoles`) over the invented game Starfall, with a fake Bedrock client, the real
 * VectorRulesRetriever, an in-memory index and the hash embedder. No AWS, no network, no cost.
 */
import { loadModelCatalog, type ModelCatalog, type QuestionTier } from '@bgr/ai';
import { RetrievalUnavailableError } from '@bgr/answering';
import { VectorRulesRetriever } from '@bgr/retrieval';
import { createLogger } from '@bgr/shared';
import { describe, expect, it } from 'vitest';
import { estimateAnswerRunUsd, formatRunPlan, resolveRunPlan } from './cli-args.js';
import { CostMeter } from './cost-meter.js';
import { loadAnswerDataset, type AnswerCase } from './dataset/answer-case-schema.js';
import { createEvalAnswerPipeline } from './live/answer-pipeline.js';
import { runAnswerEval, tierLookup } from './run-answer-eval.js';
import type { EvalConfig } from './scoring/aggregate.js';
import { fixturePath, loadStarfall } from './testing/starfall.js';

const base = loadModelCatalog();
// A fake answerer key, approved for the answerer only, priced like the default.
const catalog: ModelCatalog = {
  ...base,
  models: {
    ...base.models,
    'fake-answerer': { ...base.models[base.defaults.answerer]!, key: 'fake-answerer' },
  },
  approved: { ...base.approved, answerer: [...base.approved.answerer, 'fake-answerer'] },
};

const config: Pick<EvalConfig, 'topK' | 'rerankTopN' | 'answer' | 'answerBars'> = {
  topK: 15,
  rerankTopN: 10,
  answerBars: { maxGuesses: 0, maxForbiddenHits: 0, minEvidenceRate: 0.85, minCertaintyRate: 0.75 },
  answer: {
    runBudgetMs: 26000,
    requestTimeoutMs: 20000,
    evidenceLimits: { simple: 3, complex: 10 },
  },
};

/** What the fake answerer says per question; `cite` holds phrases of the passages it cites, or labels. */
type Scripted =
  | { certainty: 'DEFINITIVE' | 'QUALIFIED'; answer: string; cite: string[] }
  | { certainty: 'INCONCLUSIVE' };

const SCRIPT: Record<string, Scripted> = {
  'What does launching a scout ship cost in fuel?': {
    certainty: 'DEFINITIVE',
    answer: 'You pay 3 fuel.',
    cite: ['pay 3 fuel'],
  },
  'Launching from a captured station: what fuel does a scout ship cost there?': {
    certainty: 'DEFINITIVE',
    answer: 'It costs 2 fuel: the errata overrides the rulebook.',
    cite: ['costs 2 fuel instead of 3 fuel', 'pay 3 fuel'],
  },
  // Wrong on purpose: the forbidden claim must be caught.
  'After surveying a nebula, how many of the drawn star cards stay in my hand?': {
    certainty: 'DEFINITIVE',
    answer: 'You keep both star cards.',
    cite: ['keep one'],
  },
  "A comet passes my scout ship on someone else's turn. Do I still gain renown?": {
    certainty: 'DEFINITIVE',
    answer: 'Yes, you gain 1 renown immediately.',
    cite: ['gain 1 renown immediately'],
  },
  'Is there an official app for playing Starfall online?': { certainty: 'INCONCLUSIVE' },
  // A guess on a not-in-rulebook case.
  'For solo play, how does the automated rival captain choose its launch each round?': {
    certainty: 'QUALIFIED',
    answer: 'It launches first each round.',
    cite: ['P1'],
  },
};

const reply = (text: string) => ({
  output: { message: { role: 'assistant', content: [{ text }] } },
  usage: { inputTokens: 1000, outputTokens: 100 },
});

/** A Bedrock client that answers each role from its system prompt, and counts calls by role. */
function fakeBedrock(routeAs: (question: string) => QuestionTier, garble?: string) {
  const calls = { router: 0, reranker: 0, answerer: 0 };
  const client = {
    async send(command: {
      input: {
        system?: Array<{ text?: string }>;
        messages?: Array<{ content?: Array<{ text?: string }> }>;
      };
    }) {
      const system = command.input.system?.[0]?.text ?? '';
      const user = command.input.messages?.[0]?.content?.[0]?.text ?? '';
      if (system.startsWith('You classify questions')) {
        calls.router++;
        return reply(JSON.stringify({ tier: routeAs(user) }));
      }
      if (system.startsWith('You rank passages')) {
        calls.reranker++;
        const count = Number(/Return exactly (\d+) label/.exec(system)?.[1] ?? 1);
        const order = Array.from({ length: count }, (_, i) => `P${i + 1}`);
        return reply(JSON.stringify({ order }));
      }
      if (system.startsWith('You answer questions')) {
        calls.answerer++;
        const question = /<question>\n([\s\S]*?)\n<\/question>/.exec(user)?.[1] ?? '';
        // Output that fails the answer schema on every attempt.
        if (question === garble) return reply('{"certainty": "maybe"}');
        const script = SCRIPT[question];
        if (!script) throw new Error(`no script for question: ${question}`);
        if (script.certainty === 'INCONCLUSIVE') {
          return reply(
            JSON.stringify({
              appliedTier: null,
              certainty: 'INCONCLUSIVE',
              answer: 'The passages do not cover this.',
              explanation: '',
              evidence: [],
              tiers: [],
            }),
          );
        }
        const passages = [
          ...user.matchAll(/<passage id="(P\d+)"[^>]*>\nHeading: [^\n]*\n([\s\S]*?)\n<\/passage>/g),
        ].map((m) => ({ label: m[1]!, text: m[2]!.toLowerCase() }));
        const labels = script.cite.map((cite) => {
          const label = /^P\d+$/.test(cite)
            ? cite
            : passages.find((p) => p.text.includes(cite.toLowerCase()))?.label;
          if (!label) throw new Error(`"${cite}" not among the passages for: ${question}`);
          return label;
        });
        return reply(
          JSON.stringify({
            appliedTier: 'OFFICIAL',
            certainty: script.certainty,
            answer: script.answer,
            explanation: 'From the cited passage.',
            evidence: labels,
            tiers: [
              {
                tier: 'OFFICIAL',
                answer: script.answer,
                certainty: script.certainty,
                evidence: labels,
                disagreesWithApplied: false,
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected prompt: ${system.slice(0, 40)}`);
    },
  };
  return { calls, client };
}

async function setup(
  opts: {
    tierFor?: (q: string) => QuestionTier;
    routeAs?: (q: string) => QuestionTier;
    garble?: string;
  } = {},
) {
  const { documents, embeddings, index, games } = await loadStarfall();
  const cases = await loadAnswerDataset(
    [fixturePath('answer/starfall-answer-cases.jsonl')],
    [fixturePath('answer/starfall-answer-only.jsonl')],
  );
  const labelled = tierLookup(cases);
  const bedrock = fakeBedrock(opts.routeAs ?? labelled, opts.garble);
  const wired = createEvalAnswerPipeline({
    keys: { answerer: 'fake-answerer' },
    config,
    catalog,
    clientFactory: () => bedrock.client as never,
    retriever: new VectorRulesRetriever({ embeddings, index, documents, topK: config.topK }),
    documents,
    logger: createLogger({ level: 'error', sink: () => undefined }),
    ...(opts.tierFor ? { tierFor: opts.tierFor } : {}),
  });
  return { cases, games, wired, bedrock, labelled };
}

const run = (
  s: Awaited<ReturnType<typeof setup>>,
  over: {
    meter?: CostMeter;
    cases?: AnswerCase[];
    labelledTier?: boolean;
    filters?: { games?: string[]; caseIds?: string[] };
  } = {},
) =>
  runAnswerEval({
    cases: over.cases ?? s.cases,
    games: s.games,
    pipeline: s.wired.pipeline,
    models: s.wired.models,
    promptVersions: s.wired.promptVersions,
    meter: over.meter ?? new CostMeter(10),
    bars: config.answerBars,
    labelledTier: over.labelledTier ?? false,
    ...(over.filters ? { filters: over.filters } : {}),
  });

describe('answer eval PR subset (Starfall, fake Bedrock)', () => {
  it('runAnswerEval end to end on Starfall fixtures with a fake Bedrock client', async () => {
    const s = await setup();
    const report = await run(s);

    expect(report.models.answerer.key).toBe('fake-answerer');
    expect(report.promptVersions.answerer).toBe('answerer-v3');
    expect(report.cutShort).toBe(false);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(Object.keys(byId)).toHaveLength(6);

    expect(byId['starfall-answer-launch-cost']).toMatchObject({
      certaintyOk: true,
      evidenceOk: true,
      authorityOk: true,
      forbiddenHit: null,
      guess: false,
    });
    // Errata over rules: the applied ruling's authority is the errata's.
    expect(byId['starfall-answer-captured-station']).toMatchObject({
      certaintyOk: true,
      evidenceOk: true,
      authorityOk: true,
      forbiddenHit: null,
    });
    expect(byId['starfall-answer-captured-station']!.answer?.authority).toBe('OFFICIAL_ERRATA');
    expect(byId['starfall-answer-captured-station']!.citedText).toEqual([
      expect.stringContaining('costs 2 fuel instead of 3 fuel'),
      expect.stringContaining('pay 3 fuel'),
    ]);
    expect(byId['starfall-answer-survey-keep']).toMatchObject({
      certaintyOk: true,
      evidenceOk: true,
      forbiddenHit: 'keep both',
    });
    expect(byId['starfall-answer-comet-renown']).toMatchObject({
      certaintyOk: true,
      evidenceOk: true,
    });
    expect(byId['starfall-answer-online-app']).toMatchObject({
      certaintyOk: true,
      guess: false,
      evidenceOk: null,
    });
    expect(byId['starfall-answer-solo-rival']).toMatchObject({ certaintyOk: false, guess: true });

    expect(report.summary).toMatchObject({
      cases: 6,
      errors: 0,
      guesses: 1,
      evidenceRate: 1,
      verdict: 'fail',
    });
    expect(report.summary.certaintyRate).toBeCloseTo(5 / 6);
    expect(report.cost.calls).toBe(6 * 3); // router, reranker and answerer for each case
    expect(report.cost.usd).toBeGreaterThan(0);
    expect(report.cost.perQuestionUsd).toBeCloseTo(report.cost.usd / 6);
    expect(report.cases.reduce((sum, c) => sum + c.costUsd, 0)).toBeCloseTo(report.cost.usd);
  });

  it('records the --games and --cases filters it ran with', async () => {
    const s = await setup();
    const full = await run(s, { cases: s.cases.slice(0, 1) });
    expect(full.filters).toEqual({ games: null, caseIds: null });
    const subset = await run(s, {
      cases: s.cases.slice(0, 1),
      filters: { games: ['starfall'], caseIds: ['starfall-answer-launch-cost'] },
    });
    expect(subset.filters).toEqual({
      games: ['starfall'],
      caseIds: ['starfall-answer-launch-cost'],
    });
  });

  it('meter cap cuts the run short and verdict is incomplete', async () => {
    const s = await setup();
    const meter = new CostMeter(1e-12);
    const report = await run(s, { meter });

    expect(report.cases).toHaveLength(1);
    expect(report.cutShort).toBe(true);
    expect(report.summary.verdict).toBe('incomplete');
    expect(meter.exhausted).toBe(true);
  });

  it('pipeline error becomes an error row, run continues', async () => {
    // Everything routes simple, so the complex captured-station case is a misroute.
    const s = await setup({ routeAs: () => 'simple' });
    const failing =
      'For solo play, how does the automated rival captain choose its launch each round?';
    const real = s.wired.pipeline;
    s.wired.pipeline = {
      answer: (input, onCall) =>
        input.query.text === failing
          ? Promise.reject(new RetrievalUnavailableError(new Error('vector query failed')))
          : real.answer(input, onCall),
    };
    const report = await run(s);

    expect(report.cases).toHaveLength(6);
    const row = report.cases.find((c) => c.id === 'starfall-answer-solo-rival')!;
    expect(row.error).toMatch(/RetrievalUnavailableError.*vector query failed/);
    expect(row).toMatchObject({ guess: false, certaintyOk: false, routedTier: null });
    expect(row.answer).toBeUndefined();
    expect(report.summary.errors).toBe(1);
    expect(report.summary.guesses).toBe(0);
    // The errored complex case is in no misroute bucket; the captured-station case is.
    expect(report.summary.misroutes.complexAsSimple.cases).toBe(1);
  });

  it('unusable answerer output is an error row, not a right INCONCLUSIVE', async () => {
    // The pipeline answers INCONCLUSIVE when the answerer's output fails validation; on a
    // not-in-rulebook case that would score as right and hide what the model said.
    const s = await setup({ garble: 'Is there an official app for playing Starfall online?' });
    const report = await run(s);

    const row = report.cases.find((c) => c.id === 'starfall-answer-online-app')!;
    expect(row.error).toMatch(/answerer output unusable.*invalid model output/);
    expect(row).toMatchObject({ certaintyOk: false, guess: false });
    expect(row.costUsd).toBeGreaterThan(0);
    expect(report.summary.errors).toBe(1);
  });

  it('labelled-tier mode never calls the router', async () => {
    const cases = await loadAnswerDataset(
      [fixturePath('answer/starfall-answer-cases.jsonl')],
      [fixturePath('answer/starfall-answer-only.jsonl')],
    );
    // A router that would misroute everything, were it called.
    const s = await setup({ tierFor: tierLookup(cases), routeAs: () => 'simple' });
    const report = await run(s, { labelledTier: true });

    expect(s.bedrock.calls.router).toBe(0);
    expect(s.bedrock.calls.answerer).toBeGreaterThan(0);
    expect(report.labelledTier).toBe(true);
    for (const c of report.cases) expect(c.routedTier).toBe(c.labelledTier);
    expect(report.summary.misroutes.complexAsSimple.cases).toBe(0);
  });
});

describe('resolveRunPlan', () => {
  it('unknown --answerer fails before spending', () => {
    expect(() =>
      resolveRunPlan(['--answerer', 'gpt-6-luna,no-such-model', '--max-cost', '1'], catalog),
    ).toThrow('not approved for answerer');
    // A key approved for another role only is not an answerer either.
    expect(() => resolveRunPlan(['--answerer', 'nova-micro', '--max-cost', '1'], catalog)).toThrow(
      'not approved for answerer',
    );
    expect(() => resolveRunPlan(['--reranker', 'nope', '--max-cost', '1'], catalog)).toThrow(
      'not approved for reranker',
    );
  });

  it('an empty --answerer fails before spending', () => {
    for (const value of ['', ' ', ',', ' , ']) {
      expect(() => resolveRunPlan(['--answerer', value, '--max-cost', '1'], catalog)).toThrow(
        '--answerer needs at least one model key',
      );
    }
  });

  it('requires --max-cost', () => {
    expect(() => resolveRunPlan([], catalog)).toThrow(/--max-cost/);
  });

  it('defaults the answerer to the catalog default and splits lists', () => {
    expect(resolveRunPlan(['--max-cost', '0.5'], catalog)).toEqual({
      answererKeys: [catalog.defaults.answerer],
      labelledTier: false,
      markdown: false,
      maxCost: 0.5,
    });
    expect(
      resolveRunPlan(
        [
          '--answerer',
          'gpt-6-luna,fake-answerer',
          '--reranker',
          'nova-micro',
          '--games',
          'seti,wingspan',
          '--cases',
          'a,b',
          '--labelled-tier',
          '--markdown',
          '--max-cost',
          '2',
        ],
        catalog,
      ),
    ).toEqual({
      answererKeys: ['gpt-6-luna', 'fake-answerer'],
      rerankerKey: 'nova-micro',
      games: ['seti', 'wingspan'],
      caseIds: ['a', 'b'],
      labelledTier: true,
      markdown: true,
      maxCost: 2,
    });
  });

  it('prints the planned questions and the estimate against the cap', () => {
    const plan = resolveRunPlan(
      ['--answerer', 'gpt-6-luna,fake-answerer', '--max-cost', '1'],
      catalog,
    );
    expect(formatRunPlan(plan, catalog, 6)).toMatch(
      /^planned questions: 6 × 2 models; estimated cost ≈ \$\d+\.\d{4} \(cap \$1\)$/,
    );
    // Without the router the estimate is lower.
    const labelled = resolveRunPlan(['--labelled-tier', '--max-cost', '1'], catalog);
    const routed = resolveRunPlan(['--max-cost', '1'], catalog);
    expect(estimateAnswerRunUsd(labelled, catalog, 6)).toBeLessThan(
      estimateAnswerRunUsd(routed, catalog, 6),
    );
    expect(estimateAnswerRunUsd(plan, catalog, 6)).toBeCloseTo(
      2 * estimateAnswerRunUsd(routed, catalog, 6),
    );
  });
});
