import type { ModelCallRecord } from '@bgr/ai';
import {
  DailyLimitReachedError,
  ModelUnavailableError,
  RetrievalUnavailableError,
} from '@bgr/answering';
import {
  MessageSchema,
  asMessageId,
  asSessionId,
  type Authority,
  type Message,
  type ProvenanceEvidence,
  type RulesAnswer,
  type SessionId,
  type SourceType,
} from '@bgr/domain';
import { MessageIndexTakenError, type MessagesRepository } from '@bgr/persistence';
import { ZodError, z } from 'zod';
import type { AppContext } from '../lib/context.js';
import {
  badRequest,
  conflict,
  internalError,
  notFound,
  ok,
  serviceUnavailable,
  tooManyRequests,
} from '../lib/responses.js';
import { parseJsonBody, route, type RequestContext } from '../lib/router.js';

const AskSchema = z.object({ question: z.string().trim().min(1).max(1000) });

export interface Citation {
  chunkId: string;
  documentId: string;
  title: string;
  sourceType: SourceType;
  authority: Authority;
  pageStart: number;
  pageEnd: number;
  headingPath: string[];
  text: string;
  provenance: ProvenanceEvidence[];
}

export interface MessageResponse {
  messageId: string;
  answer: RulesAnswer;
  citations: Citation[];
  models: Record<string, { key: string; modelId: string }>;
  promptVersions: Record<string, string>;
}

/** Every chunk id cited anywhere in the answer, applied ruling first, once each. */
function citedChunkIds(answer: RulesAnswer): string[] {
  const ids = [...answer.evidence, ...answer.tiers.flatMap((t) => t.evidence)].map(
    (e) => e.chunkId,
  );
  return [...new Set(ids)];
}

/** A message built by the server: a schema failure here is a bug (500), never the client's fault. */
function buildMessage(fields: unknown) {
  try {
    return MessageSchema.parse(fields);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`invalid message built by the server: ${error.message}`);
    }
    throw error;
  }
}

/** The models and prompt versions that actually answered, from the successful calls. */
function servedBy(
  calls: readonly ModelCallRecord[],
): Pick<MessageResponse, 'models' | 'promptVersions'> {
  const models: MessageResponse['models'] = {};
  const promptVersions: MessageResponse['promptVersions'] = {};
  for (const c of calls) {
    if (!c.ok) continue;
    models[c.role] = { key: c.modelKey, modelId: c.modelId };
    promptVersions[c.role] = c.promptVersion;
  }
  return { models, promptVersions };
}

/** How many times an append re-reads the session and retries after another request took its index. */
const APPEND_ATTEMPTS = 3;

/**
 * Append a message at the session's next free index. The index is read (consistently) at write
 * time and the write is conditional, so a concurrent request in the same session can never
 * overwrite it; on a collision this re-reads and retries. Returns false once every attempt collided.
 */
async function appendAtNextIndex(
  messages: MessagesRepository,
  sessionId: SessionId,
  build: (index: number) => Message,
): Promise<boolean> {
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const existing = await messages.listMessages(sessionId, { consistentRead: true });
    const index = existing.reduce((max, m) => Math.max(max, m.index + 1), 0);
    try {
      await messages.appendMessage(build(index));
      return true;
    } catch (error) {
      if (!(error instanceof MessageIndexTakenError)) throw error;
    }
  }
  return false;
}

/**
 * Pipeline error mapping for POST /sessions/{id}/messages:
 * - DailyLimitReachedError → 429 DAILY_LIMIT_REACHED (try tomorrow).
 * - ModelUnavailableError → 503 MODEL_UNAVAILABLE (retryable): a Bedrock call failed, timed out,
 *   was throttled, or the run budget ran out.
 * - RetrievalUnavailableError → 503 RETRIEVAL_UNAVAILABLE (retryable): the query embedding, the
 *   vector query or the document lookup failed.
 * - Anything else → 500 INTERNAL_ERROR. None of these stores an ASSISTANT message.
 *
 * Message storage: concurrent questions in one session each take the next free index when they
 * write (see appendAtNextIndex). If the USER message still collides after the retries the request
 * is 409 CONFLICT and nothing runs; if the ASSISTANT message does, it is 500 and logged.
 */
export function messageRoutes(ctxFactory: () => AppContext) {
  const postMessage = async (rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const sessionId = asSessionId(params['sessionId'] ?? '');
    const session = await app.sessions.getSession(sessionId);
    if (!session) return notFound(`session not found: ${sessionId}`);

    let raw: unknown;
    try {
      raw = parseJsonBody(rc.event);
    } catch {
      return badRequest('request body is not valid JSON');
    }
    const { question } = AskSchema.parse(raw);

    const userMessageId = asMessageId(app.ids.messageId());
    const userStored = await appendAtNextIndex(app.messages, sessionId, (index) =>
      buildMessage({
        messageId: userMessageId,
        sessionId,
        index,
        role: 'USER',
        content: question,
        createdAt: app.clock.now().toISOString(),
      }),
    );
    if (!userStored) {
      rc.logger.warn('user message not stored: the session index stayed taken', {
        attempts: APPEND_ATTEMPTS,
      });
      return conflict('Another question in this session is being saved. Please try again.');
    }

    let outcome;
    try {
      outcome = await app.answerPipeline.answer(
        {
          query: {
            gameId: session.gameId,
            editionId: session.editionId,
            enabledContentIds: session.enabledContentIds,
            text: question,
          },
          correlationId: rc.requestId,
        },
        (record) => rc.logger.info('model call', { ...record }),
      );
    } catch (error) {
      if (error instanceof DailyLimitReachedError) {
        rc.logger.warn('daily AI limit reached');
        return tooManyRequests(
          'DAILY_LIMIT_REACHED',
          'The daily question limit has been reached. Try again tomorrow.',
        );
      }
      if (error instanceof ModelUnavailableError) {
        rc.logger.error('model unavailable', {
          error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        });
        return serviceUnavailable(
          'MODEL_UNAVAILABLE',
          "Couldn't answer right now. Please try again.",
        );
      }
      if (error instanceof RetrievalUnavailableError) {
        rc.logger.error('retrieval unavailable', {
          error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        });
        return serviceUnavailable(
          'RETRIEVAL_UNAVAILABLE',
          "Couldn't look up the rules right now. Please try again.",
        );
      }
      throw error;
    }

    const { answer, passages, documents } = outcome;
    const byChunk = new Map(passages.map((p) => [p.chunkId, p]));
    const citations: Citation[] = [];
    for (const chunkId of citedChunkIds(answer)) {
      const passage = byChunk.get(chunkId);
      if (!passage) continue;
      const doc = documents.get(passage.documentId);
      if (!doc) {
        rc.logger.warn('citation dropped: its document is missing', {
          chunkId,
          documentId: passage.documentId,
        });
        continue;
      }
      citations.push({
        chunkId,
        documentId: passage.documentId,
        title: doc.title,
        sourceType: doc.sourceType,
        authority: doc.authority,
        pageStart: passage.pageStart,
        pageEnd: passage.pageEnd,
        headingPath: passage.headingPath,
        text: passage.text,
        provenance: doc.provenance,
      });
    }

    const { models, promptVersions } = servedBy(outcome.calls);
    const messageId = asMessageId(app.ids.messageId());
    const assistantStored = await appendAtNextIndex(app.messages, sessionId, (index) =>
      buildMessage({
        messageId,
        sessionId,
        index,
        role: 'ASSISTANT',
        content: answer.answer,
        createdAt: app.clock.now().toISOString(),
        answer,
        models,
        promptVersions,
      }),
    );
    if (!assistantStored) {
      rc.logger.error('assistant message not stored: the session index stayed taken', {
        messageId,
        attempts: APPEND_ATTEMPTS,
      });
      return internalError();
    }

    const body: MessageResponse = { messageId, answer, citations, models, promptVersions };
    return ok(body);
  };

  return [route('POST', '/sessions/{sessionId}/messages', postMessage)];
}
