import {
  ApiError,
  type Authority,
  type Citation,
  type Confidence,
  type PanelTier,
  type ProvenanceEvidence,
} from './api/client';

const CONFIDENCE_PERCENT: Record<Confidence['level'], number> = { HIGH: 85, MEDIUM: 50, LOW: 25 };

export function confidencePercent(level: Confidence['level']): number {
  return CONFIDENCE_PERCENT[level];
}

const TIER_LABELS: Record<PanelTier, string> = {
  OFFICIAL: 'Official rules',
  DESIGNER_OR_PUBLISHER: 'Publisher ruling',
  COMMUNITY_CONSENSUS: 'Community consensus',
  COMMUNITY_DISCUSSION: 'Community discussion',
  UNKNOWN: 'Unknown source',
};

export function tierLabel(tier: PanelTier): string {
  return TIER_LABELS[tier];
}

function pages(start: number, end: number): string {
  return end > start ? `p.${start}–${end}` : `p.${start}`;
}

/** A short "where this came from" label for the evidence an answer cites. */
export function sourceSummary(evidence: Array<{ chunkId: string }>, citations: Citation[]): string {
  const byId = new Map(citations.map((c) => [c.chunkId, c]));
  const resolved = evidence.flatMap((e) => {
    const c = byId.get(e.chunkId);
    return c ? [c] : [];
  });
  const first = resolved[0];
  if (!first) return '';
  const docs = new Set(resolved.map((c) => c.documentId));
  if (docs.size > 1) return `${docs.size} sources`;
  const start = Math.min(...resolved.map((c) => c.pageStart));
  const end = Math.max(...resolved.map((c) => c.pageEnd));
  const label = first.sourceType === 'RULEBOOK' ? 'Rulebook' : first.title;
  return first.sourceType === 'RULEBOOK'
    ? `${label} ${pages(start, end)}`
    : `${label}, ${pages(start, end)}`;
}

const AUTHORITY_WORDS: Record<Authority, string> = {
  OFFICIAL_RULES: 'official rules',
  OFFICIAL_ERRATA: 'official errata',
  DESIGNER_OR_PUBLISHER: 'a designer or publisher ruling',
  COMMUNITY_CONSENSUS: 'community consensus',
  COMMUNITY_DISCUSSION: 'community discussion',
  UNKNOWN: 'an unknown source',
};

function phrase(e: ProvenanceEvidence): string {
  switch (e.kind) {
    case 'OPERATOR_ATTESTED':
      return `added by the operator as ${AUTHORITY_WORDS[e.authority]} ✓`;
    case 'SOURCE_HOST':
      return `fetched from ${e.host}`;
    case 'UPLOADED_FILE':
      return e.filename ? `uploaded file ${e.filename}` : 'uploaded file';
    case 'COMMUNITY_HOST_DOWNGRADE':
      return `${e.host} is a community site, so it was downgraded from ${AUTHORITY_WORDS[e.from]} to ${AUTHORITY_WORDS[e.to]}`;
    case 'COMMUNITY_CONTENT_REMOVED':
      return e.regions === 1
        ? '1 community-written section removed'
        : `${e.regions} community-written sections removed`;
  }
}

export function provenanceLine(evidence: ProvenanceEvidence[]): string {
  return evidence.map(phrase).join(' · ');
}

export function askErrorMessage(err: unknown): { message: string; sessionEnded: boolean } {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return {
        message: 'This session has ended. Start a new one from the game screen.',
        sessionEnded: true,
      };
    }
    switch (err.code) {
      case 'DAILY_LIMIT_REACHED':
        return {
          message: "Today's question limit is used up. Try again tomorrow.",
          sessionEnded: false,
        };
      case 'MODEL_UNAVAILABLE':
      case 'RETRIEVAL_UNAVAILABLE':
        return { message: err.message, sessionEnded: false };
      case 'CONFLICT':
        return {
          message: 'Another question is still being answered. Try again in a moment.',
          sessionEnded: false,
        };
    }
  }
  return { message: 'Something went wrong. Please try again.', sessionEnded: false };
}
