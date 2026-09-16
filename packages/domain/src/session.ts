import { z } from 'zod';
import { ContentIdSchema, EditionIdSchema, GameIdSchema, SessionIdSchema } from './ids.js';

/**
 * Session record. Full conversation history is stored separately in
 * `messages` (see MessageSchema); the session record only carries the
 * game configuration, the (later) rolling summary and lifecycle timestamps.
 * See ADR-0004.
 */
export const SessionSchema = z.object({
  sessionId: SessionIdSchema,
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  enabledContentIds: z.array(ContentIdSchema).default([]),
  configurationFingerprint: z.string().length(64),
  conversationSummary: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  /** Unix seconds — DynamoDB TTL attribute (numeric, epoch seconds). */
  ttl: z.number().int().positive(),
});
export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionInputSchema = z.object({
  gameId: GameIdSchema,
  editionId: EditionIdSchema,
  enabledContentIds: z.array(ContentIdSchema).default([]),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

export const SessionViewSchema = SessionSchema.omit({ ttl: true });
export type SessionView = z.infer<typeof SessionViewSchema>;
