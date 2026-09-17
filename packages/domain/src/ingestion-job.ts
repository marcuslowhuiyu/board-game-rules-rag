import { z } from 'zod';
import {
  ContentIdSchema,
  EditionIdSchema,
  GameIdSchema,
  IngestionJobIdSchema,
  SourceDocumentIdSchema,
} from './ids.js';
import { AuthoritySchema, SourceTypeSchema } from './source-document.js';

/**
 * Stages of the Step Functions state machine (MASTER_PLAN §47).
 * `EMBED` / `INDEX` are declared but skipped in M2 — they light up in M3.
 */
export const INGESTION_STAGES = [
  'VALIDATE',
  'FETCH',
  'PARSE',
  'CLASSIFY',
  'DISCOVER_ERRATA',
  'NORMALIZE',
  'CHUNK',
  'EMBED',
  'INDEX',
  'FINALIZE',
] as const;
export const IngestionStageSchema = z.enum(INGESTION_STAGES);
export type IngestionStage = z.infer<typeof IngestionStageSchema>;

export const INGESTION_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export const IngestionStatusSchema = z.enum(INGESTION_STATUSES);
export type IngestionStatus = z.infer<typeof IngestionStatusSchema>;

/** Where the raw source came from — one of these is always set. */
export const IngestionSourceRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('S3'),
    s3Key: z.string().min(1).max(500),
    contentType: z.string().min(1).max(120),
    filename: z.string().max(300).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('URL'),
    url: z.string().url().max(2048),
  }),
]);
export type IngestionSourceRef = z.infer<typeof IngestionSourceRefSchema>;

/** Payload accepted by POST /ingestion. */
export const CreateIngestionJobInputSchema = z.object({
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  contentId: ContentIdSchema,
  title: z.string().min(1).max(300),
  sourceType: SourceTypeSchema,
  authority: AuthoritySchema,
  source: IngestionSourceRefSchema,
  /** Optional label for the source version (`v1.4`, `2024-05`, …). */
  version: z.string().max(80).optional(),
  /** Override for unit tests / synthetic failures ("normalize", "chunk" …). */
  forceFailureStage: IngestionStageSchema.optional(),
});
export type CreateIngestionJobInput = z.infer<typeof CreateIngestionJobInputSchema>;

/**
 * Persisted ingestion job. Written once at create-time, mutated by each
 * stage. The Step Functions execution owns retries and stage sequencing;
 * this record is the observable status for the UI (`GET /ingestion/{jobId}`).
 */
export const IngestionJobSchema = z.object({
  jobId: IngestionJobIdSchema,
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  contentId: ContentIdSchema,
  title: z.string().min(1).max(300),
  sourceType: SourceTypeSchema,
  authority: AuthoritySchema,
  source: IngestionSourceRefSchema,
  status: IngestionStatusSchema,
  stage: IngestionStageSchema,
  completedStages: z.array(IngestionStageSchema).default([]),
  documentId: SourceDocumentIdSchema.optional(),
  chunkCount: z.number().int().nonnegative().optional(),
  duplicateOf: SourceDocumentIdSchema.optional(),
  supersededDocumentId: SourceDocumentIdSchema.optional(),
  version: z.string().max(80).optional(),
  forceFailureStage: IngestionStageSchema.optional(),
  error: z
    .object({
      stage: IngestionStageSchema,
      message: z.string().max(2000),
      code: z.string().max(80).optional(),
    })
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IngestionJob = z.infer<typeof IngestionJobSchema>;

/** JSON view returned by `GET /ingestion/{jobId}` — omits internal fields. */
export const IngestionJobViewSchema = IngestionJobSchema.omit({ forceFailureStage: true });
export type IngestionJobView = z.infer<typeof IngestionJobViewSchema>;

/** Payload accepted by POST /uploads/presign. */
export const CreatePresignedUploadInputSchema = z.object({
  filename: z.string().min(1).max(300),
  contentType: z.string().min(1).max(120),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
});
export type CreatePresignedUploadInput = z.infer<typeof CreatePresignedUploadInputSchema>;
