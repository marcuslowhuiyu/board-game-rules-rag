import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { cryptoIdGenerator } from '@bgr/persistence';
import type { UploadPresigner } from './context.js';

export interface S3UploadPresignerOptions {
  bucket: string;
  region: string;
  expirySeconds: number;
  maxBytes: number;
  /** Tests only — production resolves the Lambda role's credentials. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function createS3UploadPresigner(opts: S3UploadPresignerOptions): UploadPresigner {
  const s3 = new S3Client({
    region: opts.region,
    // The SDK's default ('WHEN_SUPPORTED') presigns the CRC32 of the absent
    // body — the empty-content checksum — so S3 rejects the real upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  });
  return {
    async createPut({ contentType, sizeBytes, filename }) {
      const dateKey = new Date().toISOString().slice(0, 10);
      const rand = cryptoIdGenerator.sourceDocumentId().replace(/^doc_/, '');
      const ext = pickExtension(contentType, filename);
      const key = `raw/${dateKey}/${rand}${ext}`;
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: sizeBytes,
        }),
        { expiresIn: opts.expirySeconds },
      );
      const expiresAt = new Date(Date.now() + opts.expirySeconds * 1000).toISOString();
      return { url, key, contentType, expiresAt, maxBytes: opts.maxBytes };
    },
  };
}

function pickExtension(contentType: string, filename?: string): string {
  const fromFile = filename?.match(/\.[a-zA-Z0-9]+$/)?.[0];
  if (fromFile) return fromFile.toLowerCase();
  switch (contentType.toLowerCase()) {
    case 'application/pdf':
      return '.pdf';
    case 'text/html':
    case 'application/xhtml+xml':
      return '.html';
    default:
      return '.bin';
  }
}
