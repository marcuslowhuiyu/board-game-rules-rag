import { z } from 'zod';
import { MessageIdSchema, SessionIdSchema } from './ids.js';

export const MESSAGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM'] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * Message shape used across milestones. M1 defines the schema and DDB layout;
 * M4 fills in structured-answer fields (evidence, authority, certainty), M5
 * consumes them for rolling summaries. Kept intentionally minimal here.
 */
export const MessageSchema = z.object({
  messageId: MessageIdSchema,
  sessionId: SessionIdSchema,
  index: z.number().int().nonnegative(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;
