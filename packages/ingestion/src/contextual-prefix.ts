export interface ContextualPrefixInput {
  gameName: string;
  contentName: string;
  headingPath: string[];
  text: string;
}

/**
 * Build the text form that will be embedded in M3. Prepending a small amount
 * of context ("Game: … / Content: … / Section: … > …") noticeably improves
 * retrieval when many games share the same terminology (e.g. `HIT` in TI4
 * vs Root). See MASTER_PLAN §15.
 */
export function contextualPrefix({
  gameName,
  contentName,
  headingPath,
  text,
}: ContextualPrefixInput): string {
  const section = headingPath.length > 0 ? headingPath.join(' > ') : '(untitled section)';
  return `Game: ${gameName}\nContent: ${contentName}\nSection: ${section}\n\n${text}`;
}
