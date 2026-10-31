import type { ModelAnswer } from '@bgr/ai';
import { panelTierOf } from '@bgr/domain';
import type {
  Authority,
  Certainty,
  PanelTier,
  ProvenanceEvidence,
  RulesAnswer,
  TierAnswer,
} from '@bgr/domain';
import { confidenceFor } from './confidence.js';

/**
 * A passage that was sent to the model. Its panel tier is always derived from
 * `authority` (`panelTierOf`), never supplied, so the two cannot disagree.
 */
export interface CitedSource {
  chunkId: string;
  authority: Authority;
  provenance: readonly ProvenanceEvidence[];
}

/** Highest first. */
const AUTHORITY_ORDER: readonly Authority[] = [
  'OFFICIAL_ERRATA',
  'OFFICIAL_RULES',
  'DESIGNER_OR_PUBLISHER',
  'COMMUNITY_CONSENSUS',
  'COMMUNITY_DISCUSSION',
  'UNKNOWN',
];

const NOT_SETTLED_ANSWER = 'The rules passages found do not settle this question.';
const REJECTED_EXPLANATION =
  'The answer could not be checked against the cited rules passages, so it is not given.';
const NO_WORDING_EXPLANATION = 'The rules passages found do not answer this question.';

/** A safe INCONCLUSIVE ruling with no evidence; used for invalid model output. */
export function inconclusiveAnswer(explanation: string): RulesAnswer {
  return {
    certainty: 'INCONCLUSIVE',
    authority: 'UNKNOWN',
    answer: NOT_SETTLED_ANSWER,
    explanation,
    evidence: [],
    needsResearch: true,
    // Built per call: callers may mutate the result.
    confidence: confidenceFor({
      certainty: 'INCONCLUSIVE',
      tier: 'UNKNOWN',
      cited: [],
      sourcesDisagree: false,
    }),
    appliedTier: null,
    tiers: [],
    sourcesDisagree: false,
    requiresPlayerChoice: false,
  };
}

/**
 * Resolves P-labels to the passages that were sent, de-duplicated by chunk.
 * Returns null if any label is unknown or points at a passage that was not sent.
 */
function resolve(
  evidence: readonly string[],
  labels: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, CitedSource>,
): CitedSource[] | null {
  const cited = new Map<string, CitedSource>();
  for (const label of evidence) {
    const chunkId = labels.get(label);
    if (chunkId === undefined || chunkId.length === 0) return null;
    const source = sources.get(chunkId);
    if (source === undefined) return null;
    // Cite the chunk id as sent, whatever the stored record says.
    if (!cited.has(chunkId)) cited.set(chunkId, { ...source, chunkId });
  }
  return [...cited.values()];
}

const rank = (authority: Authority): number => {
  const i = AUTHORITY_ORDER.indexOf(authority);
  return i === -1 ? AUTHORITY_ORDER.length : i;
};

/** The cited source with the highest authority; `cited` must be non-empty. */
const strongest = (cited: readonly CitedSource[]): CitedSource =>
  cited.reduce((best, s) => (rank(s.authority) < rank(best.authority) ? s : best));

const refs = (cited: readonly CitedSource[]): { chunkId: string }[] =>
  cited.map((s) => ({ chunkId: s.chunkId }));

interface Panel {
  tier: PanelTier;
  answer: string;
  certainty: Certainty;
  cited: CitedSource[];
  /** The model's claim that this panel's ruling differs from the applied ruling. */
  disagreesWithApplied: boolean;
}

/**
 * Keeps a tier panel only if it settles the question, has wording, and has evidence
 * that is all known and all from its own tier. The first surviving panel per tier wins.
 */
function survivingPanels(
  tiers: ModelAnswer['tiers'],
  labels: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, CitedSource>,
): Panel[] {
  const kept = new Map<PanelTier, Panel>();
  for (const t of tiers) {
    if (kept.has(t.tier) || t.certainty === 'INCONCLUSIVE') continue;
    // A blank panel is no ruling, the same as a blank applied answer.
    if (t.answer.trim().length === 0) continue;
    const cited = resolve(t.evidence, labels, sources);
    if (cited === null || cited.length === 0) continue;
    if (cited.some((s) => panelTierOf(s.authority) !== t.tier)) continue;
    kept.set(t.tier, {
      tier: t.tier,
      answer: t.answer,
      certainty: t.certainty,
      cited,
      disagreesWithApplied: t.disagreesWithApplied,
    });
  }
  return [...kept.values()];
}

/**
 * Whether the OFFICIAL and DESIGNER_OR_PUBLISHER rulings are known to differ from each other.
 * Each side's ruling is its surviving panel, or the applied ruling when that is of its tier and it
 * has no panel. The flags compare each panel with the applied ruling, so two sides differ exactly
 * when one matches the applied ruling and the other does not. When both differ from it (a ruling
 * of a third tier) the flags cannot tell whether they differ from each other, so no conflict is claimed.
 */
function officialAndDesignerDisagree(
  panels: readonly Panel[],
  appliedTier: PanelTier | null,
): boolean {
  const differsFromApplied = (tier: PanelTier): boolean | undefined => {
    const panel = panels.find((p) => p.tier === tier);
    if (panel !== undefined) return panel.disagreesWithApplied;
    return appliedTier === tier ? false : undefined;
  };
  const official = differsFromApplied('OFFICIAL');
  const designer = differsFromApplied('DESIGNER_OR_PUBLISHER');
  return official !== undefined && designer !== undefined && official !== designer;
}

/**
 * Checks the model's answer against the passages that were actually sent and
 * derives authority, confidence and the disagreement flags in code. Anything
 * that cannot be verified becomes INCONCLUSIVE rather than a ruling.
 *
 * labels: P-label → chunkId as sent; sources: every passage that was sent.
 */
export function validateAnswer(
  output: ModelAnswer,
  labels: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, CitedSource>,
): RulesAnswer {
  const panels = survivingPanels(output.tiers, labels, sources);
  // Derived from the surviving panels only: a dropped panel's claim counts for nothing.
  const sourcesDisagree = panels.some((p) => p.disagreesWithApplied);

  const tiers: TierAnswer[] = panels.map((p) => ({
    tier: p.tier,
    answer: p.answer,
    certainty: p.certainty,
    evidence: refs(p.cited),
    // A panel's confidence also reflects whether it agrees with the other panels.
    confidence: confidenceFor({
      certainty: p.certainty,
      tier: p.tier,
      cited: p.cited,
      sourcesDisagree,
    }),
  }));

  // An INCONCLUSIVE ruling's answer is always the fixed message, so a hedge never reads as a ruling.
  const notSettled = (explanation: string): RulesAnswer => ({
    ...inconclusiveAnswer(explanation),
    tiers,
    sourcesDisagree,
    requiresPlayerChoice: officialAndDesignerDisagree(panels, null),
  });

  if (output.certainty === 'INCONCLUSIVE') {
    // The model's own wording goes into the explanation; its labels and tier are not kept.
    const wording = [output.answer, output.explanation]
      .map((w) => w.trim())
      .filter((w) => w.length > 0)
      .join('\n\n');
    return notSettled(wording.length > 0 ? wording : NO_WORDING_EXPLANATION);
  }

  const cited = resolve(output.evidence, labels, sources);
  // A blank ruling is no ruling, whatever its certainty and evidence.
  if (cited === null || cited.length === 0 || output.answer.trim().length === 0) {
    // An unverifiable ruling: never show its wording, not even in the explanation.
    return notSettled(REJECTED_EXPLANATION);
  }

  const top = strongest(cited);
  const appliedTier = panelTierOf(top.authority);
  const requiresPlayerChoice = officialAndDesignerDisagree(panels, appliedTier);
  const certainty: Certainty =
    requiresPlayerChoice && output.certainty === 'DEFINITIVE' ? 'QUALIFIED' : output.certainty;

  return {
    certainty,
    authority: top.authority,
    answer: output.answer,
    explanation: output.explanation,
    evidence: refs(cited),
    needsResearch: false,
    confidence: confidenceFor({ certainty, tier: appliedTier, cited, sourcesDisagree }),
    appliedTier,
    tiers,
    sourcesDisagree,
    requiresPlayerChoice,
  };
}
