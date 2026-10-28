import {
  ConflictError,
  asSourceDocumentId,
  type Authority,
  type ProvenanceEvidence,
  type SourceDocument,
  type SourceType,
} from '@bgr/domain';
import { buildProvenance } from '@bgr/ingestion';
import type { DocumentsRepository } from '@bgr/persistence';

export interface BackfillEntry {
  documentId: string;
  title: string;
  sourceType: SourceType;
  authority: Authority;
  canonicalUrl?: string;
  /** Pins the version the operator saw; a changed row is never overwritten. */
  updatedAt: string;
  proposed: ProvenanceEvidence[];
  /** The operator flips this to true after reviewing the entry. */
  confirmed: boolean;
}

/**
 * Proposals for CURRENT documents that have no provenance. Old documents
 * record no declared tier or comment count, so the stored tier stands in for
 * both declared and classified, and no removal evidence is proposed.
 */
export function planBackfill(docs: SourceDocument[], now: string): BackfillEntry[] {
  return docs
    .filter((d) => d.status === 'CURRENT' && d.provenance.length === 0)
    .map((d) => ({
      documentId: d.documentId,
      title: d.title,
      sourceType: d.sourceType,
      authority: d.authority,
      ...(d.canonicalUrl !== undefined ? { canonicalUrl: d.canonicalUrl } : {}),
      updatedAt: d.updatedAt,
      proposed: buildProvenance({
        declaredAuthority: d.authority,
        classifiedAuthority: d.authority,
        origin: d.origin,
        ...(d.canonicalUrl !== undefined ? { canonicalUrl: d.canonicalUrl } : {}),
        now,
      }),
      confirmed: false,
    }));
}

const CHANGED = 'changed since the plan was written';

/** Applies only confirmed entries whose document is still as planned. */
export async function applyBackfill(
  entries: BackfillEntry[],
  repo: Pick<DocumentsRepository, 'getDocument' | 'setProvenance'>,
  now: string,
): Promise<{ applied: string[]; skipped: { documentId: string; reason: string }[] }> {
  const applied: string[] = [];
  const skipped: { documentId: string; reason: string }[] = [];
  for (const entry of entries) {
    const skip = (reason: string) => skipped.push({ documentId: entry.documentId, reason });
    if (!entry.confirmed) {
      skip('not confirmed');
      continue;
    }
    const id = asSourceDocumentId(entry.documentId);
    const current = await repo.getDocument(id);
    if (!current) {
      skip('not found');
    } else if (current.provenance.length > 0) {
      skip('already has provenance');
    } else if (current.updatedAt !== entry.updatedAt) {
      skip(CHANGED);
    } else {
      try {
        await repo.setProvenance(id, entry.proposed, entry.updatedAt, now);
        applied.push(entry.documentId);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        skip(CHANGED);
      }
    }
  }
  return { applied, skipped };
}
