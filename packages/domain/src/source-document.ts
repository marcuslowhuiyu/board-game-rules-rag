import { z } from 'zod';
import { ContentIdSchema, EditionIdSchema, GameIdSchema, SourceDocumentIdSchema } from './ids.js';

export const SOURCE_TYPES = [
  'RULEBOOK',
  'RULES_REFERENCE',
  'FAQ',
  'ERRATA',
  'LIVING_RULES',
  'PROMO_RULES',
  'DESIGNER_RULING',
  'PUBLISHER_RULING',
  'COMMUNITY_THREAD',
  'OTHER',
] as const;
export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const AUTHORITIES = [
  'OFFICIAL_RULES',
  'OFFICIAL_ERRATA',
  'DESIGNER_OR_PUBLISHER',
  'COMMUNITY_CONSENSUS',
  'COMMUNITY_DISCUSSION',
  'UNKNOWN',
] as const;
export const AuthoritySchema = z.enum(AUTHORITIES);
export type Authority = z.infer<typeof AuthoritySchema>;

/**
 * Lifecycle of a source document (MASTER_PLAN §18):
 * - `CURRENT`   — the authoritative version for its (edition, contentId, sourceType)
 * - `SUPERSEDED` — replaced by a newer document; kept for provenance
 * - `ARCHIVED`   — manually withdrawn
 */
export const SOURCE_STATUSES = ['CURRENT', 'SUPERSEDED', 'ARCHIVED'] as const;
export const SourceStatusSchema = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const SOURCE_ORIGINS = ['UPLOAD', 'URL'] as const;
export const SourceOriginSchema = z.enum(SOURCE_ORIGINS);
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;

/**
 * SourceDocument as it lands in DynamoDB. Chunk bodies are stored in S3
 * (`normalized/<documentId>/<chunkId>.txt`); chunk metadata is a separate
 * table. See MASTER_PLAN §13 for the field list, §18 for dedup, §19 for
 * knowledgeRevision.
 */
export const SourceDocumentSchema = z.object({
  documentId: SourceDocumentIdSchema,
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  contentId: ContentIdSchema,
  title: z.string().min(1).max(300),
  sourceType: SourceTypeSchema,
  authority: AuthoritySchema,
  origin: SourceOriginSchema,
  version: z.string().max(80).optional(),
  publicationDate: z.string().date().optional(),
  effectiveDate: z.string().date().optional(),
  canonicalUrl: z.string().url().optional(),
  publisherDomain: z.string().max(200).optional(),
  /** SHA-256 hex of the raw source bytes. Required — this is the dedup key. */
  contentHash: z.string().length(64),
  /** S3 URI (`s3://bucket/key`) of the raw source we fetched. */
  rawObjectUri: z.string().min(1).max(500),
  pageCount: z.number().int().nonnegative().optional(),
  chunkCount: z.number().int().nonnegative().default(0),
  status: SourceStatusSchema,
  supersedes: z.array(SourceDocumentIdSchema).default([]),
  knowledgeRevision: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

/**
 * Backwards-compatible alias used by M1 tests / code that only needed the
 * metadata shape. New code should reference `SourceDocument`.
 */
export const SourceDocumentMetadataSchema = SourceDocumentSchema;
export type SourceDocumentMetadata = SourceDocument;
