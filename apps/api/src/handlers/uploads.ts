import { CreatePresignedUploadInputSchema } from '@bgr/domain';
import type { AppContext } from '../lib/context.js';
import { isAllowedUploadContentType } from '../lib/context.js';
import { badRequest, ok } from '../lib/responses.js';
import { parseJsonBody, route, type RequestContext } from '../lib/router.js';

export function uploadRoutes(ctxFactory: () => AppContext) {
  const createPresign = async (rc: RequestContext) => {
    const app = ctxFactory();
    const input = CreatePresignedUploadInputSchema.parse(parseJsonBody(rc.event));
    if (!isAllowedUploadContentType(input.contentType)) {
      return badRequest(`disallowed content type: ${input.contentType}`);
    }
    if (input.sizeBytes > app.config.uploadMaxBytes) {
      return badRequest(`sizeBytes ${input.sizeBytes} exceeds cap ${app.config.uploadMaxBytes}`);
    }
    const presigned = await app.presigner.createPut({
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      filename: input.filename,
    });
    rc.logger.info('upload presigned', { key: presigned.key });
    return ok({
      url: presigned.url,
      key: presigned.key,
      contentType: presigned.contentType,
      expiresAt: presigned.expiresAt,
      maxBytes: presigned.maxBytes,
      method: 'PUT',
      requiredHeaders: { 'content-type': presigned.contentType },
    });
  };

  return [route('POST', '/uploads/presign', createPresign)];
}
