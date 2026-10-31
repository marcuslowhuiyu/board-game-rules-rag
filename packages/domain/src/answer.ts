import { z } from 'zod';
import { AuthoritySchema, type Authority } from './authority.js';

export const CERTAINTIES = ['DEFINITIVE', 'QUALIFIED', 'INCONCLUSIVE'] as const;
export const CertaintySchema = z.enum(CERTAINTIES);
export type Certainty = (typeof CERTAINTIES)[number];

/** Panels group authorities: OFFICIAL_RULES and OFFICIAL_ERRATA share the OFFICIAL panel. */
export const PANEL_TIERS = [
  'OFFICIAL',
  'DESIGNER_OR_PUBLISHER',
  'COMMUNITY_CONSENSUS',
  'COMMUNITY_DISCUSSION',
  'UNKNOWN',
] as const;
export const PanelTierSchema = z.enum(PANEL_TIERS);
export type PanelTier = (typeof PANEL_TIERS)[number];

export function panelTierOf(authority: Authority): PanelTier {
  return authority === 'OFFICIAL_RULES' || authority === 'OFFICIAL_ERRATA' ? 'OFFICIAL' : authority;
}

export const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_REASONS = [
  'DIRECTLY_STATED',
  'BEST_READING',
  'NOT_SETTLED',
  'OPERATOR_ATTESTED',
  'MISSING_PROVENANCE',
  'COMMUNITY_SOURCE',
  'SOURCES_DISAGREE',
] as const;
export const ConfidenceReasonSchema = z.enum(CONFIDENCE_REASONS);
export type ConfidenceReason = (typeof CONFIDENCE_REASONS)[number];

export const ConfidenceSchema = z.object({
  level: ConfidenceLevelSchema,
  reasons: z.array(ConfidenceReasonSchema),
});
export type Confidence = z.infer<typeof ConfidenceSchema>;

const EvidenceRefSchema = z.object({ chunkId: z.string().min(1) });

export const TierAnswerSchema = z.object({
  tier: PanelTierSchema,
  answer: z.string(),
  certainty: CertaintySchema,
  evidence: z.array(EvidenceRefSchema),
  confidence: ConfidenceSchema,
});
export type TierAnswer = z.infer<typeof TierAnswerSchema>;

export const RulesAnswerSchema = z.object({
  certainty: CertaintySchema,
  authority: AuthoritySchema,
  answer: z.string(),
  explanation: z.string(),
  evidence: z.array(EvidenceRefSchema),
  needsResearch: z.boolean(),
  confidence: ConfidenceSchema,
  appliedTier: PanelTierSchema.nullable(),
  tiers: z.array(TierAnswerSchema),
  sourcesDisagree: z.boolean(),
  requiresPlayerChoice: z.boolean(),
});
/** The applied ruling; derived from the schema so the two cannot drift. */
export type RulesAnswer = z.infer<typeof RulesAnswerSchema>;
