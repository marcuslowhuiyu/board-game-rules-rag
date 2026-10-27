import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { AuthoritySchema } from '@bgr/domain';
import { z } from 'zod';

const MAX_PHRASE_WORDS = 15;

/**
 * One piece of evidence a case needs, identified by a stable rule key and
 * matched by phrase (and heading), never by chunk id, so re-chunking does
 * not break the dataset. Phrases are short anchors, not rulebook excerpts.
 */
export const EvidenceItemSchema = z.object({
  key: z.string().min(1).max(120),
  phrase: z
    .string()
    .min(1)
    .max(120)
    .refine((p) => p.trim().split(/\s+/).length <= MAX_PHRASE_WORDS, {
      message: `phrase must be at most ${MAX_PHRASE_WORDS} words`,
    }),
  heading: z.string().min(1).max(120).optional(),
  /** Required items decide pass/fail; supporting items are only reported. */
  required: z.boolean(),
  authority: AuthoritySchema.optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const RetrievalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'id must be kebab-case'),
    game: z.string().min(1),
    edition: z.string().min(1),
    enabledContent: z.array(z.string().min(1)).min(1),
    tier: z.enum(['simple', 'complex']),
    question: z.string().min(1).max(400),
    requiredEvidence: z.array(EvidenceItemSchema).min(1),
    source: z.object({ url: z.string().url(), title: z.string().min(1) }),
    notes: z.string().optional(),
    /** Reserved for M6 (errata, forum and designer evidence); ignored here. */
    futureEvidence: z.array(z.unknown()).optional(),
  })
  .superRefine((c, ctx) => {
    // Items are scored by key, so a repeated key would let one item mask another.
    const keys = new Set<string>();
    for (const e of c.requiredEvidence) {
      if (keys.has(e.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requiredEvidence'],
          message: `duplicate evidence key ${e.key}`,
        });
      }
      keys.add(e.key);
    }
    const required = c.requiredEvidence.filter((e) => e.required).length;
    if (c.tier === 'simple' && required !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['requiredEvidence'],
        message: `a simple case needs exactly one required item; got ${required}`,
      });
    }
    if (c.tier === 'complex' && required < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['requiredEvidence'],
        message: `a complex case needs at least two required items; got ${required}`,
      });
    }
  });
export type RetrievalCase = z.infer<typeof RetrievalCaseSchema>;

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetError';
  }
}

/** Loads and validates JSONL datasets. Any bad line or duplicate id fails the whole load. */
export async function loadDataset(paths: readonly string[]): Promise<RetrievalCase[]> {
  const cases: RetrievalCase[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const lines = (await readFile(path, 'utf8')).split('\n');
    for (const [i, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const where = `${basename(path)}:${i + 1}`;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (err) {
        throw new DatasetError(`${where}: invalid JSON (${(err as Error).message})`);
      }
      const parsed = RetrievalCaseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DatasetError(`${where}: ${z.prettifyError(parsed.error)}`);
      }
      if (seen.has(parsed.data.id)) {
        throw new DatasetError(`${where}: duplicate case id ${parsed.data.id}`);
      }
      seen.add(parsed.data.id);
      cases.push(parsed.data);
    }
  }
  return cases;
}
