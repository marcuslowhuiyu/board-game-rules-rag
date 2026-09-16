import { z } from 'zod';
import { ContentIdSchema, EditionIdSchema, GameIdSchema } from './ids.js';

export const CONTENT_TYPES = [
  'BASE',
  'EXPANSION',
  'PROMO',
  'MODULE',
  'MINI_EXPANSION',
  'OTHER_OPTIONAL_CONTENT',
] as const;
export const ContentTypeSchema = z.enum(CONTENT_TYPES);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const CONTENT_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'] as const;
export const ContentStatusSchema = z.enum(CONTENT_STATUSES);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

/**
 * A ContentPackage carries both an internal `contentId` (used everywhere in
 * DynamoDB / vector metadata) and a human-readable `slug` unique per
 * (gameId, editionId). Golden eval fixtures reference content by slug; runtime
 * storage always uses the id. This closes G14.
 */
export const ContentPackageSchema = z.object({
  contentId: ContentIdSchema,
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case'),
  name: z.string().min(1).max(200),
  contentType: ContentTypeSchema,
  releaseDate: z.string().date().optional(),
  dependencies: z.array(ContentIdSchema).default([]),
  status: ContentStatusSchema,
});
export type ContentPackage = z.infer<typeof ContentPackageSchema>;
