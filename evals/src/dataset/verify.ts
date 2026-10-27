import { evidenceMatches } from '../scoring/match.js';
import type { RetrievalCase } from './case-schema.js';

export interface VerifyIssue {
  caseId: string;
  itemKey: string;
  problem: 'phrase-not-found' | 'heading-mismatch' | 'phrase-in-multiple-games';
}

type ChunkText = { text: string; headingPath: string[] };

/**
 * Checks every evidence item against the ingested text before a case is
 * committed. A phrase must sit inside a single chunk of the case's game
 * (one split across a chunk boundary could never be retrieved), its heading
 * must match that chunk, and it should not also occur in another game, which
 * usually means the phrase is too generic or filed under the wrong game.
 */
export function verifyDataset(
  cases: readonly RetrievalCase[],
  chunksByGame: Record<string, readonly ChunkText[]>,
): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const c of cases) {
    for (const item of c.requiredEvidence) {
      const phraseOnly = { ...item, heading: undefined };
      const issue = (problem: VerifyIssue['problem']) =>
        issues.push({ caseId: c.id, itemKey: item.key, problem });

      const holders = (chunksByGame[c.game] ?? []).filter((ch) => evidenceMatches(phraseOnly, ch));
      if (holders.length === 0) {
        issue('phrase-not-found');
        continue;
      }
      if (item.heading !== undefined && !holders.some((ch) => evidenceMatches(item, ch))) {
        issue('heading-mismatch');
        continue;
      }
      const elsewhere = Object.entries(chunksByGame).some(
        ([game, chunks]) => game !== c.game && chunks.some((ch) => evidenceMatches(phraseOnly, ch)),
      );
      if (elsewhere) issue('phrase-in-multiple-games');
    }
  }
  return issues;
}
