import { z } from 'zod';
import { AuthoritySchema } from './authority.js';

/**
 * Evidence for why a source's authority tier is trusted. The `authority`
 * field stays the stored tier; provenance records the evidence behind it.
 */
export const PROVENANCE_KINDS = [
  'OPERATOR_ATTESTED', // the tier declared when the source was added
  'SOURCE_HOST', // the host a URL source was fetched from
  'UPLOADED_FILE', // the operator uploaded the bytes
  'COMMUNITY_HOST_DOWNGRADE', // CLASSIFY lowered the tier because of the host
  'COMMUNITY_CONTENT_REMOVED', // the parser removed reader comments
] as const;

export const ProvenanceEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('OPERATOR_ATTESTED'),
    authority: AuthoritySchema,
    recordedAt: z.string().datetime(),
  }),
  z.object({ kind: z.literal('SOURCE_HOST'), host: z.string().min(1).max(253) }),
  z.object({ kind: z.literal('UPLOADED_FILE'), filename: z.string().max(300).optional() }),
  z.object({
    kind: z.literal('COMMUNITY_HOST_DOWNGRADE'),
    host: z.string().min(1).max(253),
    from: AuthoritySchema,
    to: AuthoritySchema,
  }),
  z.object({ kind: z.literal('COMMUNITY_CONTENT_REMOVED'), regions: z.number().int().positive() }),
]);
export type ProvenanceEvidence = z.infer<typeof ProvenanceEvidenceSchema>;

export const ProvenanceSchema = z.array(ProvenanceEvidenceSchema).max(20);
