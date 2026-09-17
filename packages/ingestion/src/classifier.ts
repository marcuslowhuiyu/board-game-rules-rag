import type { Authority, SourceType } from '@bgr/domain';

/**
 * Very small MIME/hint→sourceType/authority classifier. In M2 the operator
 * hands us the `sourceType` + `authority` at ingestion time, so the classifier
 * only validates the pairing and applies a couple of defensive tightenings
 * (a community forum URL should never come through as OFFICIAL_RULES, for
 * example). Real automated errata discovery lives in M6.
 */
export interface ClassificationInput {
  sourceType: SourceType;
  authority: Authority;
  canonicalUrl?: string;
  filename?: string;
}

export interface ClassificationResult {
  sourceType: SourceType;
  authority: Authority;
  warnings: string[];
}

const COMMUNITY_HOSTS = ['boardgamegeek.com', 'reddit.com', 'discord.gg', 'discord.com'];

export function classifySource(input: ClassificationInput): ClassificationResult {
  const warnings: string[] = [];
  let authority = input.authority;
  const canonical = input.canonicalUrl?.toLowerCase();
  if (canonical) {
    try {
      const host = new URL(canonical).hostname;
      if (COMMUNITY_HOSTS.some((h) => host.endsWith(h))) {
        if (authority === 'OFFICIAL_RULES' || authority === 'OFFICIAL_ERRATA') {
          warnings.push(
            `URL host ${host} looks community-run; downgrading authority to COMMUNITY_DISCUSSION`,
          );
          authority = 'COMMUNITY_DISCUSSION';
        }
      }
    } catch {
      // ignore — url validated elsewhere
    }
  }
  return { sourceType: input.sourceType, authority, warnings };
}
