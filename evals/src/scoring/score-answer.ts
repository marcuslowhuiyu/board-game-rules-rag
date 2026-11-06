import type { QuestionTier } from '@bgr/ai';
import type { ConfidenceLevel, RulesAnswer } from '@bgr/domain';
import type { RetrievedChunk } from '@bgr/retrieval';
import type { AnswerCase } from '../dataset/answer-case-schema.js';
import { evidenceMatches, normalize } from './match.js';

export interface AnswerCaseScore {
  id: string;
  kind: AnswerCase['kind'];
  /** Set when the pipeline threw; the case then counts as a miss everywhere. */
  error?: string;
  certaintyOk: boolean;
  /** Not-in-rulebook case given a ruling: a non-INCONCLUSIVE answer or tier panel. */
  guess: boolean;
  /** null for not-in-rulebook cases. */
  evidenceOk: boolean | null;
  authorityOk: boolean | null;
  /** The first forbidden claim found in the answer, explanation or a panel answer. */
  forbiddenHit: string | null;
  disagreeOk: boolean | null;
  playerChoiceOk: boolean | null;
  confidence: ConfidenceLevel | null;
  routedTier: QuestionTier | null;
  labelledTier: QuestionTier;
}

export type AnswerRun =
  | { answer: RulesAnswer; passages: readonly RetrievedChunk[]; tier: QuestionTier }
  | { error: string };

/** Deterministic checks of one pipeline run against the case's expectations. */
export function scoreAnswerCase(c: AnswerCase, run: AnswerRun): AnswerCaseScore {
  const expected = c.case.answer;
  const answerable = c.kind === 'answerable';
  const base = { id: c.case.id, kind: c.kind, labelledTier: c.case.tier };
  const expects = <T>(v: T | undefined): v is T => v !== undefined;

  if ('error' in run) {
    return {
      ...base,
      error: run.error,
      certaintyOk: false,
      guess: false,
      evidenceOk: answerable ? false : null,
      authorityOk: expects(expected.authority) ? false : null,
      forbiddenHit: null,
      disagreeOk: expects(expected.sourcesDisagree) ? false : null,
      playerChoiceOk: expects(expected.requiresPlayerChoice) ? false : null,
      confidence: null,
      routedTier: null,
    };
  }

  const { answer, passages } = run;

  // Only the applied ruling's own citations count: not panels, not uncited passages.
  let evidenceOk: boolean | null = null;
  if (c.kind === 'answerable') {
    const cited = new Set(answer.evidence.map((e) => e.chunkId));
    const citedPassages = passages.filter((p) => cited.has(p.chunkId));
    evidenceOk = c.case.requiredEvidence
      .filter((item) => item.required)
      .every((item) => citedPassages.some((p) => evidenceMatches(item, p)));
  }

  const texts = [answer.answer, answer.explanation, ...answer.tiers.map((t) => t.answer)].map(
    normalize,
  );
  const forbiddenHit =
    (expected.forbiddenClaims ?? []).find((claim) => {
      const needle = normalize(claim);
      return texts.some((t) => t.includes(needle));
    }) ?? null;

  return {
    ...base,
    certaintyOk: answer.certainty === expected.certainty,
    // A tier panel's ruling is shown to the player too, so it counts even under an INCONCLUSIVE answer.
    guess:
      !answerable &&
      (answer.certainty !== 'INCONCLUSIVE' ||
        answer.tiers.some((t) => t.certainty !== 'INCONCLUSIVE')),
    evidenceOk,
    authorityOk: expects(expected.authority) ? answer.authority === expected.authority : null,
    forbiddenHit,
    disagreeOk: expects(expected.sourcesDisagree)
      ? answer.sourcesDisagree === expected.sourcesDisagree
      : null,
    playerChoiceOk: expects(expected.requiresPlayerChoice)
      ? answer.requiresPlayerChoice === expected.requiresPlayerChoice
      : null,
    confidence: answer.confidence.level,
    routedTier: run.tier,
  };
}
