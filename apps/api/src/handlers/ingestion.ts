import {
  CreateIngestionJobInputSchema,
  IngestionJobSchema,
  IngestionJobViewSchema,
  asIngestionJobId,
  type IngestionJob,
} from '@bgr/domain';
import type { AppContext } from '../lib/context.js';
import { badRequest, created, notFound, ok } from '../lib/responses.js';
import { parseJsonBody, route, type RequestContext } from '../lib/router.js';

export function ingestionRoutes(ctxFactory: () => AppContext) {
  const createJob = async (rc: RequestContext) => {
    const app = ctxFactory();
    const input = CreateIngestionJobInputSchema.parse(parseJsonBody(rc.event));

    const game = await app.games.getGame(input.gameId);
    if (!game) return badRequest(`unknown gameId: ${input.gameId}`);
    if (!game.editions.some((e) => e.editionId === input.editionId)) {
      return badRequest(`unknown editionId for game ${input.gameId}: ${input.editionId}`);
    }
    const content = await app.games.listContent(input.gameId);
    const pkg = content.find((c) => c.contentId === input.contentId);
    if (!pkg) return badRequest(`unknown contentId: ${input.contentId}`);
    if (pkg.editionId !== input.editionId) {
      return badRequest(
        `content ${input.contentId} belongs to edition ${pkg.editionId}, not ${input.editionId}`,
      );
    }

    // For S3 uploads, sanity-check that the object exists — otherwise the
    // FETCH stage would fail deep in the pipeline for a preventable reason.
    if (input.source.kind === 'S3') {
      try {
        await app.rawStore.getBytes(app.rawStore.toUri(input.source.s3Key));
      } catch {
        return badRequest(`s3 object not found: ${input.source.s3Key}`);
      }
    }

    const nowIso = app.clock.now().toISOString();
    const jobId = asIngestionJobId(app.ids.ingestionJobId());
    // Deliberately do NOT read `forceFailureStage` from `input` — the public
    // schema does not carry it (ADR-0008 §R8 / test-only affordance). Tests
    // that need synthetic failures construct jobs against
    // `InternalCreateIngestionJobInputSchema` directly.
    const job: IngestionJob = IngestionJobSchema.parse({
      jobId,
      gameId: input.gameId,
      editionId: input.editionId,
      contentId: input.contentId,
      title: input.title,
      sourceType: input.sourceType,
      authority: input.authority,
      source: input.source,
      status: 'PENDING',
      stage: 'VALIDATE',
      completedStages: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    await app.ingestionJobs.createJob(job);
    try {
      await app.executor.start(jobId);
    } catch (err) {
      rc.logger.error('failed to start ingestion state machine', {
        jobId,
        message: err instanceof Error ? err.message : String(err),
      });
      // Conditional: StartExecution may have been accepted with only the
      // response lost, and the execution may already have finished. A job
      // that reached a terminal state is reported as-is, never downgraded.
      const outcome = await app.ingestionJobs.markFailedIfActive(
        jobId,
        {
          stage: 'VALIDATE',
          message: 'failed to start state machine',
          code: 'START_EXECUTION_FAILED',
        },
        app.clock.now().toISOString(),
      );
      if (outcome === 'NOT_APPLIED') {
        const current = await app.ingestionJobs.getJob(jobId);
        if (current && current.status !== 'FAILED') {
          return created(IngestionJobViewSchema.parse(current));
        }
      }
      return badRequest('failed to start ingestion');
    }
    rc.logger.info('ingestion started', { jobId });
    return created(IngestionJobViewSchema.parse(job));
  };

  const getJob = async (_rc: RequestContext, params: Record<string, string>) => {
    const app = ctxFactory();
    const jobId = asIngestionJobId(params['jobId'] ?? '');
    const job = await app.ingestionJobs.getJob(jobId);
    if (!job) return notFound(`ingestion job not found: ${jobId}`);
    return ok(IngestionJobViewSchema.parse(job));
  };

  return [route('POST', '/ingestion', createJob), route('GET', '/ingestion/{jobId}', getJob)];
}
