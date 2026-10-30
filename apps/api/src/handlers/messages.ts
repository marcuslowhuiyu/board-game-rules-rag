import { DailyLimitReachedError, ModelUnavailableError } from '@bgr/answering';
import {
  MessageSchema,
  asMessageId,
  asSessionId,
  asSourceDocumentId,
  type Authority,
  type ProvenanceEvidence,
  type RulesAnswer,
  type SourceType,
} from '@bgr/domain';
import { z } from 'zod';
import type { AppContext } from '../lib/context.js';
import { badRequest, notFound, ok, serviceUnavailable, tooManyRequests } from '../lib/responses.js';
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

    const index = (await app.messages.listMessages(sessionId)).length;
    await app.messages.appendMessage(
      MessageSchema.parse({
        messageId: asMessageId(app.ids.messageId()),
        sessionId,
        index,
        role: 'USER',
        content: question,
        createdAt: app.clock.now().toISOString(),
      }),
    );

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
      throw error;
    }

    const { answer, passages } = outcome;
    const byChunk = new Map(passages.map((p) => [p.chunkId, p]));
    const documents = new Map<
      string,
      Awaited<ReturnType<AppContext['documents']['getDocument']>>
    >();
    const citations: Citation[] = [];
    for (const chunkId of citedChunkIds(answer)) {
      const passage = byChunk.get(chunkId);
      if (!passage) continue;
      if (!documents.has(passage.documentId)) {
        documents.set(
          passage.documentId,
          await app.documents.getDocument(asSourceDocumentId(passage.documentId)),
        );
      }
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

    const { models, promptVersions } = app.answerMeta;
    const messageId = asMessageId(app.ids.messageId());
    await app.messages.appendMessage(
      MessageSchema.parse({
        messageId,
        sessionId,
        index: index + 1,
        role: 'ASSISTANT',
        content: answer.answer,
        createdAt: app.clock.now().toISOString(),
        answer,
        models,
        promptVersions,
      }),
    );

    const body: MessageResponse = { messageId, answer, citations, models, promptVersions };
    return ok(body);
  };

  return [route('POST', '/sessions/{sessionId}/messages', postMessage)];
}
