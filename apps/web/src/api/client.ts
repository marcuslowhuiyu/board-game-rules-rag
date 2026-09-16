export interface Edition {
  editionId: string;
  gameId: string;
  name: string;
  publisher?: string;
  releaseYear?: number;
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
    // `same-origin` is the fetch default, but stating it explicitly documents
    // the same-origin design (CloudFront serves both the SPA and `/api/*` —
    // see ADR-0007) and makes it a compile-error if we ever accidentally
    // point the client at a cross-site URL without revisiting the strategy.
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
  };
}
