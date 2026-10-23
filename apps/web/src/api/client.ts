export interface Edition {
  editionId: string;
  gameId: string;
  name: string;
  publisher?: string;
  releaseYear?: number;
  knowledgeRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContentPackage {
  contentId: string;
  gameId: string;
  editionId: string;
  slug: string;
  name: string;
  contentType:
    'BASE' | 'EXPANSION' | 'PROMO' | 'MODULE' | 'MINI_EXPANSION' | 'OTHER_OPTIONAL_CONTENT';
  releaseDate?: string;
  dependencies: string[];
  status: 'DRAFT' | 'READY' | 'ARCHIVED';
}

export interface Game {
  gameId: string;
  slug: string;
  name: string;
  publisher?: string;
  description?: string;
  editions: Edition[];
  createdAt: string;
  updatedAt: string;
}

export interface GameWithContent extends Game {
  content: ContentPackage[];
}

export interface SessionView {
  sessionId: string;
  gameId: string;
  editionId: string;
  enabledContentIds: string[];
  configurationFingerprint: string;
  conversationSummary?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CreateGameInput {
  name: string;
  slug?: string;
  publisher?: string;
  description?: string;
  initialEdition?: {
    name: string;
    publisher?: string;
    releaseYear?: number;
  };
}

export interface CreateSessionInput {
  gameId: string;
  editionId: string;
  enabledContentIds: string[];
}

export type SourceType =
  | 'RULEBOOK'
  | 'RULES_REFERENCE'
  | 'FAQ'
  | 'ERRATA'
  | 'LIVING_RULES'
  | 'PROMO_RULES'
  | 'DESIGNER_RULING'
  | 'PUBLISHER_RULING'
  | 'COMMUNITY_THREAD'
  | 'OTHER';

export type Authority =
  | 'OFFICIAL_RULES'
  | 'OFFICIAL_ERRATA'
  | 'DESIGNER_OR_PUBLISHER'
  | 'COMMUNITY_CONSENSUS'
  | 'COMMUNITY_DISCUSSION'
  | 'UNKNOWN';

export type IngestionStage =
  | 'VALIDATE'
  | 'FETCH'
  | 'PARSE'
  | 'CLASSIFY'
  | 'DISCOVER_ERRATA'
  | 'NORMALIZE'
  | 'CHUNK'
  | 'EMBED'
  | 'INDEX'
  | 'FINALIZE';

export type IngestionStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface IngestionJobView {
  jobId: string;
  gameId: string;
  editionId: string;
  contentId: string;
  title: string;
  sourceType: SourceType;
  authority: Authority;
  source:
    | { kind: 'S3'; s3Key: string; contentType: string; filename?: string; sizeBytes?: number }
    | { kind: 'URL'; url: string };
  status: IngestionStatus;
  stage: IngestionStage;
  completedStages: IngestionStage[];
  documentId?: string;
  chunkCount?: number;
  duplicateOf?: string;
  supersededDocumentId?: string;
  version?: string;
  error?: { stage: IngestionStage; message: string; code?: string };
  createdAt: string;
  updatedAt: string;
}

export interface PresignedUploadResponse {
  url: string;
  key: string;
  contentType: string;
  expiresAt: string;
  maxBytes: number;
  method: 'PUT';
  requiredHeaders: Record<string, string>;
}

export interface CreateIngestionJobInput {
  gameId: string;
  editionId: string;
  contentId: string;
  title: string;
  sourceType: SourceType;
  authority: Authority;
  source: IngestionJobView['source'];
  version?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text.length ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `request failed (${res.status})`,
      err?.details,
    );
  }
  return data as T;
}

export interface ApiClient {
  listGames(query?: string): Promise<{ items: Game[] }>;
  getGame(gameId: string): Promise<GameWithContent>;
  createGame(input: CreateGameInput): Promise<Game>;
  createSession(input: CreateSessionInput): Promise<SessionView>;
  deleteSession(sessionId: string): Promise<void>;
  presignUpload(input: {
    filename: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<PresignedUploadResponse>;
  uploadFile(presign: PresignedUploadResponse, file: File): Promise<void>;
  createIngestion(input: CreateIngestionJobInput): Promise<IngestionJobView>;
  getIngestion(jobId: string): Promise<IngestionJobView>;
}

export function createApiClient(baseUrl: string): ApiClient {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    listGames: (q) => {
      const qs = q ? `?q=${encodeURIComponent(q)}` : '';
      return request<{ items: Game[] }>(`${base}/games${qs}`);
    },
    getGame: (gameId) => request<GameWithContent>(`${base}/games/${encodeURIComponent(gameId)}`),
    createGame: (input) =>
      request<Game>(`${base}/games`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    createSession: (input) =>
      request<SessionView>(`${base}/sessions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    deleteSession: (sessionId) =>
      request<void>(`${base}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }),
    presignUpload: (input) =>
      request<PresignedUploadResponse>(`${base}/uploads/presign`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    uploadFile: async (presign, file) => {
      const res = await fetch(presign.url, {
        method: 'PUT',
        headers: presign.requiredHeaders,
        body: file,
      });
      if (!res.ok) {
        throw new ApiError(res.status, 'UPLOAD_FAILED', `S3 upload failed: ${res.status}`);
      }
    },
    createIngestion: (input) =>
      request<IngestionJobView>(`${base}/ingestion`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    getIngestion: (jobId) =>
      request<IngestionJobView>(`${base}/ingestion/${encodeURIComponent(jobId)}`),
  };
}
