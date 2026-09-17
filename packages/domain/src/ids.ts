import { z } from 'zod';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

const brandedId = <B extends string>() =>
  z.string().regex(idPattern, `id must match ${idPattern.source}`).brand<B>();

export const GameIdSchema = brandedId<'GameId'>();
export const EditionIdSchema = brandedId<'EditionId'>();
export const ContentIdSchema = brandedId<'ContentId'>();
export const SessionIdSchema = brandedId<'SessionId'>();
export const MessageIdSchema = brandedId<'MessageId'>();
export const SourceDocumentIdSchema = brandedId<'SourceDocumentId'>();
export const ChunkIdSchema = brandedId<'ChunkId'>();
export const IngestionJobIdSchema = brandedId<'IngestionJobId'>();

export type GameId = z.infer<typeof GameIdSchema>;
export type EditionId = z.infer<typeof EditionIdSchema>;
export type ContentId = z.infer<typeof ContentIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type SourceDocumentId = z.infer<typeof SourceDocumentIdSchema>;
export type ChunkId = z.infer<typeof ChunkIdSchema>;
export type IngestionJobId = z.infer<typeof IngestionJobIdSchema>;

export const asGameId = (value: string): GameId => GameIdSchema.parse(value);
export const asEditionId = (value: string): EditionId => EditionIdSchema.parse(value);
export const asContentId = (value: string): ContentId => ContentIdSchema.parse(value);
export const asSessionId = (value: string): SessionId => SessionIdSchema.parse(value);
export const asMessageId = (value: string): MessageId => MessageIdSchema.parse(value);
export const asSourceDocumentId = (value: string): SourceDocumentId =>
  SourceDocumentIdSchema.parse(value);
export const asChunkId = (value: string): ChunkId => ChunkIdSchema.parse(value);
export const asIngestionJobId = (value: string): IngestionJobId =>
  IngestionJobIdSchema.parse(value);
