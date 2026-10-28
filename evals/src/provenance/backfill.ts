import { z } from 'zod';
import {
  AuthoritySchema,
  ConflictError,
  ProvenanceSchema,
  SourceTypeSchema,
  asSourceDocumentId,
  type SourceDocument,
} from '@bgr/domain';
import { buildProvenance } from '@bgr/ingestion';
import type { DocumentsRepository } from '@bgr/persistence';

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

/** The plan file as the operator edited it; anything else is rejected whole. */
export const BackfillEntrySchema = z.object({
  documentId: z.string().min(1),
  title: z.string(),
  sourceType: SourceTypeSchema,
  authority: AuthoritySchema,
  canonicalUrl: z.string().optional(),
  updatedAt: z.string().min(1),
  proposed: ProvenanceSchema,
  confirmed: z.boolean(),
});
export const BackfillPlanSchema = z.array(BackfillEntrySchema);
/**
 * `updatedAt` pins the version the operator saw (a changed row is never
 * overwritten); the operator flips `confirmed` to true after review.
 */
export type BackfillEntry = z.infer<typeof BackfillEntrySchema>;

/** Collects every item of a paged scan, following the continuation key. */
export async function scanAll<T, K = string>(
  page: (startKey: K | undefined) => Promise<{ items: T[]; next?: K | undefined }>,
): Promise<T[]> {
  const out: T[] = [];
  let key: K | undefined;
  do {
    const res = await page(key);
    out.push(...res.items);
    key = res.next;
  } while (key);
  return out;
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
