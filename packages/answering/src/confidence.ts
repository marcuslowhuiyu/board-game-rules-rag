import type {
  Certainty,
  Confidence,
  ConfidenceLevel,
  ConfidenceReason,
  PanelTier,
} from '@bgr/domain';
import type { CitedSource } from './validate-answer.js';

const COMMUNITY_TIERS: ReadonlySet<PanelTier> = new Set([
  'COMMUNITY_CONSENSUS',
  'COMMUNITY_DISCUSSION',
  'UNKNOWN',
]);

const capAtMedium = (level: ConfidenceLevel): ConfidenceLevel =>
  level === 'HIGH' ? 'MEDIUM' : level;
const dropOne = (level: ConfidenceLevel): ConfidenceLevel => (level === 'HIGH' ? 'MEDIUM' : 'LOW');

/** The operator attested this source's stored authority, and nothing downgraded it since. */
function isAttested(source: CitedSource): boolean {
  return (
    source.provenance.some(
      (p) => p.kind === 'OPERATOR_ATTESTED' && p.authority === source.authority,
    ) && !source.provenance.some((p) => p.kind === 'COMMUNITY_HOST_DOWNGRADE')
  );
}

/** Deterministic confidence for a ruling; every adjustment is listed as a reason. */
export function confidenceFor(input: {
  certainty: Certainty;
  tier: PanelTier;
  cited: readonly CitedSource[];
  sourcesDisagree: boolean;
}): Confidence {
  if (input.certainty === 'INCONCLUSIVE') return { level: 'LOW', reasons: ['NOT_SETTLED'] };

  let level: ConfidenceLevel = input.certainty === 'DEFINITIVE' ? 'HIGH' : 'MEDIUM';
  const reasons: ConfidenceReason[] = [
    input.certainty === 'DEFINITIVE' ? 'DIRECTLY_STATED' : 'BEST_READING',
  ];

  // No cited sources is never "all attested".
  if (input.cited.length > 0 && input.cited.every(isAttested)) {
    reasons.push('OPERATOR_ATTESTED');
  } else {
    level = capAtMedium(level);
    reasons.push('MISSING_PROVENANCE');
  }

  if (COMMUNITY_TIERS.has(input.tier)) {
    level = capAtMedium(level);
    reasons.push('COMMUNITY_SOURCE');
  }

  if (input.sourcesDisagree) {
    level = dropOne(level);
    reasons.push('SOURCES_DISAGREE');
  }

  return { level, reasons };
}
