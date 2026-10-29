/**
 * A single logical block of extracted content — heading, paragraph, list
 * item. Blocks preserve enough context for the chunker to group them under
 * a heading path, and carry page metadata for citations. See MASTER_PLAN
 * §14, §15.
 */
export interface ParsedBlock {
  /** Outermost-first heading path this block sits under. */
  headingPath: string[];
  /** Whether this block is itself a heading (chunker uses this to open new sections). */
  isHeading?: boolean;
  /** Heading depth (1 = h1). Only meaningful when `isHeading` is true. */
  headingDepth?: number;
  /** 1-indexed page range. `pageEnd === pageStart` for single-page blocks. */
  pageStart: number;
  pageEnd: number;
  /** Normalized text — collapsed whitespace, no reserved control chars. */
  text: string;
}

export interface DocumentQualityReport {
  emptyPageRatio: number;
  averageCharsPerPage: number;
  garbledCharRatio: number;
  /** True when the parser found no extractable text — likely a scan. */
  isLikelyScan: boolean;
  warnings: string[];
}

export interface ParsedDocument {
  pageCount: number;
  blocks: ParsedBlock[];
  quality: DocumentQualityReport;
  /** Reader-comment regions the parser removed (HTML only). */
  communityRegionsRemoved?: number;
}

export interface ChunkOutput {
  ordinal: number;
  headingPath: string[];
  pageStart: number;
  pageEnd: number;
  text: string;
  charCount: number;
  tokenCount: number;
}
