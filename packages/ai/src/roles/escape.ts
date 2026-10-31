/**
 * Passage text, headings, metadata and the player's question are untrusted: neutralise any
 * opening or closing passage(s) or question tag so they cannot forge or end a delimiter.
 */
export const escapeDelimiters = (text: string): string =>
  text.replace(/<(\/?)(passage|question)/gi, '<\\$1$2');

/** For a value inside a double-quoted attribute: also neutralise the quote that would end it. */
export const escapeAttribute = (value: string): string =>
  escapeDelimiters(value).replace(/"/g, '&quot;');
