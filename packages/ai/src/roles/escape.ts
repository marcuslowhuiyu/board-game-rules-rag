/**
 * Passage text, headings and metadata come from untrusted documents: neutralise any opening or
 * closing passage tag so they cannot forge or end a delimiter.
 */
export const escapeDelimiters = (text: string): string =>
  text.replace(/<(\/?)passage/gi, '<\\$1passage');

/** For a value inside a double-quoted attribute: also neutralise the quote that would end it. */
export const escapeAttribute = (value: string): string =>
  escapeDelimiters(value).replace(/"/g, '&quot;');
