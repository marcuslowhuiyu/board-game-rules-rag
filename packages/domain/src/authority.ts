import { z } from 'zod';

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
