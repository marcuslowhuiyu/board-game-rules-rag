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

export const SOURCE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'ARCHIVED'] as const;
export const SourceStatusSchema = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

/**
 * Document-level metadata only. Ingestion (chunks/vectors) lives in M2/M3.
 * M1 exposes just the shape so downstream milestones don't need to migrate.
 */
export const SourceDocumentMetadataSchema = z.object({
  documentId: SourceDocumentIdSchema,
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  contentId: ContentIdSchema,
  title: z.string().min(1).max(300),
  sourceType: SourceTypeSchema,
  authority: AuthoritySchema,
  version: z.string().max(80).optional(),
  publicationDate: z.string().date().optional(),
  effectiveDate: z.string().date().optional(),
  canonicalUrl: z.string().url().optional(),
  publisherDomain: z.string().max(200).optional(),
  contentHash: z.string().length(64).optional(),
  status: SourceStatusSchema,
  supersedes: z.array(SourceDocumentIdSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SourceDocumentMetadata = z.infer<typeof SourceDocumentMetadataSchema>;
