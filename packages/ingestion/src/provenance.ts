import type { Authority, ProvenanceEvidence } from '@bgr/domain';

export interface ProvenanceInput {
  /** `job.authority` before CLASSIFY: what the operator declared. */
  declaredAuthority: Authority;
  /** `classifySource(...).authority`: the tier actually stored. */
  classifiedAuthority: Authority;
  origin: 'UPLOAD' | 'URL';
  canonicalUrl?: string;
  filename?: string;
  communityRegionsRemoved?: number;
  /** ISO datetime the evidence is recorded. */
  now: string;
}

/**
 * Evidence for why a source is trusted. Only checks the system performed and
 * the operator's declaration count; nothing the content says about itself.
 */
export function buildProvenance(input: ProvenanceInput): ProvenanceEvidence[] {
  const evidence: ProvenanceEvidence[] = [
    { kind: 'OPERATOR_ATTESTED', authority: input.declaredAuthority, recordedAt: input.now },
  ];
  const host = input.canonicalUrl ? hostOf(input.canonicalUrl) : undefined;
  if (input.origin === 'UPLOAD') {
    evidence.push({
      kind: 'UPLOADED_FILE',
      ...(input.filename !== undefined ? { filename: input.filename } : {}),
    });
  } else if (host) {
    evidence.push({ kind: 'SOURCE_HOST', host });
  }
  if (host && input.declaredAuthority !== input.classifiedAuthority) {
    evidence.push({
      kind: 'COMMUNITY_HOST_DOWNGRADE',
      host,
      from: input.declaredAuthority,
      to: input.classifiedAuthority,
    });
  }
  if (input.communityRegionsRemoved !== undefined && input.communityRegionsRemoved > 0) {
    evidence.push({ kind: 'COMMUNITY_CONTENT_REMOVED', regions: input.communityRegionsRemoved });
  }
  return evidence;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}
