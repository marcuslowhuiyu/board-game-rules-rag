import {
  createHtmlParser,
  createPdfTextLayerParser,
  createS3Fetcher,
  createUrlFetcher,
  type ChunkerOptions,
  type DocumentFetcher,
  type DocumentParser,
  type PdfExtractor,
} from '@bgr/ingestion';
import type { InMemoryDocumentsRepository, InMemoryGamesRepository } from '@bgr/persistence';
import { InMemoryAtomicPublisher, type AtomicPublisher, type IdGenerator } from '@bgr/persistence';
import type { AppContext } from '../lib/context.js';
import type { StageContext } from './pipeline.js';

export interface StageContextOverrides {
  ids?: IdGenerator;
  pdfExtractor?: PdfExtractor;
  pdfParser?: DocumentParser;
  htmlParser?: DocumentParser;
  urlFetcher?: DocumentFetcher;
  s3Fetcher?: DocumentFetcher;
  publisher?: AtomicPublisher;
  chunkerOptions?: ChunkerOptions;
  now?: () => Date;
}

export function makeStageContext(
  app: AppContext,
  overrides: StageContextOverrides = {},
): StageContext {
  // Delegate to the AppContext's id generator so callers who wire in a
  // sequential id generator get unique ids per call (chunks, documents, jobs
  // all need distinct ids within a single stage run).
  const ids: IdGenerator = overrides.ids ?? app.ids;
  const pdfExtractor: PdfExtractor = overrides.pdfExtractor ?? {
    extract: async () => ({ pages: [''] }),
  };
  const pdfParser = overrides.pdfParser ?? createPdfTextLayerParser(pdfExtractor);
  const htmlParser = overrides.htmlParser ?? createHtmlParser();
  const s3Fetcher = overrides.s3Fetcher ?? createS3Fetcher(app.rawStore);
  const urlFetcher = overrides.urlFetcher ?? createUrlFetcher();
  // The test AppContext always uses the in-memory repos, so we can build
  // the in-memory publisher against those. Callers who supply their own
  // publisher (e.g. failure-injection stubs) can override.
  const publisher =
    overrides.publisher ??
    new InMemoryAtomicPublisher(
      app.documents as InMemoryDocumentsRepository,
      app.games as InMemoryGamesRepository,
    );
  const ctx: StageContext = {
    now: overrides.now ?? (() => app.clock.now()),
    ids,
    documents: app.documents,
    chunks: app.chunks,
    jobs: app.ingestionJobs,
    games: app.games,
    publisher,
    rawStore: app.rawStore,
    normalizedStore: app.normalizedStore,
    urlFetcher,
    s3Fetcher,
    pdfParser,
    htmlParser,
  };
  if (overrides.chunkerOptions !== undefined) ctx.chunkerOptions = overrides.chunkerOptions;
  return ctx;
}

/**
 * Sequential id generator for tests. Each call produces the next value in
 * the source's own sequence — `doc_1`, `doc_2`, `ch_1`, … — so we can assert
 * on stable identifiers without hard-coding UUIDs.
 */
export function sequentialIds(): IdGenerator {
  let seq = 0;
  const next = (prefix: string) => `${prefix}_${++seq}`;
  return {
    gameId: () => next('g'),
    editionId: () => next('e'),
    contentId: () => next('c'),
    sessionId: () => next('s'),
    messageId: () => next('m'),
    sourceDocumentId: () => next('doc'),
    chunkId: () => next('ch'),
    ingestionJobId: () => next('job'),
  };
}
