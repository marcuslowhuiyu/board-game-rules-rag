import { z } from 'zod';
import { EditionIdSchema, GameIdSchema } from './ids.js';

/**
 * `knowledgeRevision` is bumped whenever authoritative knowledge attached to
 * this edition materially changes (new document ingested, previous document
 * superseded, errata discovered). See MASTER_PLAN §19 and ADR-0008.
 * M2 introduces the field; M6 ruling cache invalidates on mismatch.
 */
export const EditionSchema = z.object({
  editionId: EditionIdSchema,
  gameId: GameIdSchema,
  name: z.string().min(1).max(200),
  publisher: z.string().min(1).max(200).optional(),
  releaseYear: z.number().int().min(1900).max(2100).optional(),
  knowledgeRevision: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Edition = z.infer<typeof EditionSchema>;

export const GameSchema = z.object({
  gameId: GameIdSchema,
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case'),
  name: z.string().min(1).max(200),
  publisher: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  editions: z.array(EditionSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Game = z.infer<typeof GameSchema>;

/** Payload accepted by POST /games — metadata only, no ingestion. */
export const CreateGameInputSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case')
    .optional(),
  publisher: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  initialEdition: z
    .object({
      name: z.string().min(1).max(200),
      publisher: z.string().min(1).max(200).optional(),
      releaseYear: z.number().int().min(1900).max(2100).optional(),
    })
    .optional(),
});
export type CreateGameInput = z.infer<typeof CreateGameInputSchema>;
