import { z } from 'zod';
import {
  ChunkIdSchema,
  ContentIdSchema,
  EditionIdSchema,
  GameIdSchema,
  SourceDocumentIdSchema,
} from './ids.js';
import { AuthoritySchema, SourceTypeSchema } from './source-document.js';

/**
 * Chunk record persisted in DynamoDB (metadata) alongside the raw normalized
 * text stored in S3 at `normalized/<documentId>/<chunkId>.txt`. See
 * MASTER_PLAN §14. Vectors (M3) will carry only the fields required for
 * filtering — retrieval joins back to this record via `chunkId`.
 *
 * `pageStart` / `pageEnd` are 1-indexed physical pages. `headingPath` is the
 * outermost-first list of headings that contain this chunk (e.g. `["Space
 * Combat", "Assign Hits"]`). Empty when the chunker could not detect any
 * heading structure — chunker still emits the chunk, but downstream heuristics
 * can flag such documents for manual review.
 */
export const ChunkSchema = z.object({
  chunkId: ChunkIdSchema,
  documentId: SourceDocumentIdSchema,
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  contentId: ContentIdSchema,
  ordinal: z.number().int().nonnegative(),
  headingPath: z.array(z.string().min(1).max(300)).max(16).default([]),
  pageStart: z.number().int().positive(),
  pageEnd: z.number().int().positive(),
  /** S3 URI where the normalized chunk body is stored. */
  textUri: z.string().min(1).max(500),
  /** Cached copy of the chunk text (kept small; storage of truth is S3). */
  textPreview: z.string().max(800),
  charCount: z.number().int().nonnegative(),
  tokenCount: z.number().int().nonnegative(),
  authority: AuthoritySchema,
  sourceType: SourceTypeSchema,
  documentVersion: z.string().max(80).optional(),
  createdAt: z.string().datetime(),
});
export type Chunk = z.infer<typeof ChunkSchema>;
