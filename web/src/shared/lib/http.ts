import type { ApiErrorDto, ErrorCode } from "../../types.ts";

export type ApiError =
  | { kind: "network"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "bad-request"; message: string }
  | {
      kind: "quota";
      message: string;
      retryAfterMs: number;
      phase: "rewrite" | "answer" | "unknown";
    }
  | { kind: "unsupported-file"; message: string }
  | { kind: "too-large"; message: string }
  | { kind: "server"; message: string }
  | { kind: "aborted"; message: string };

export class ApiRequestError extends Error {
  readonly cause: ApiError;

  // Explicit assignment: `erasableSyntaxOnly` bans parameter properties.
  constructor(cause: ApiError) {
    super(cause.message);
    this.name = "ApiRequestError";
    this.cause = cause;
  }
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiRequestError) return error.cause;
  if (error instanceof Error) return { kind: "network", message: error.message };
  return { kind: "network", message: String(error) };
}

const CODE_TO_KIND: Partial<Record<ErrorCode, ApiError["kind"]>> = {
  not_found: "not-found",
  bad_request: "bad-request",
  conflict: "bad-request",
  unsupported_type: "unsupported-file",
  payload_too_large: "too-large",
  needs_ocr: "unsupported-file",
  no_text: "unsupported-file",
  internal: "server",
};

async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorDto | null = null;
  try {
    body = (await response.json()) as ApiErrorDto;
  } catch {
    // Not JSON. The status is still meaningful.
  }
  const message = body?.error?.message ?? `${response.status} ${response.statusText}`;

  if (response.status === 429) {
    return {
      kind: "quota",
      message,
      retryAfterMs: body?.error?.retryAfterMs ?? 60_000,
      phase: body?.error?.phase ?? "unknown",
    };
  }

  const kind = (body?.error?.code && CODE_TO_KIND[body.error.code]) ?? undefined;
  if (kind) return { kind, message } as ApiError;
  if (response.status === 404) return { kind: "not-found", message };
  if (response.status >= 500) return { kind: "server", message };
  return { kind: "bad-request", message };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(signal ? { signal } : {}),
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiRequestError({ kind: "aborted", message: "request cancelled" });
    }
    throw new ApiRequestError({
      kind: "network",
      message:
        "Could not reach the API. Is it running? Start it with `npm run api` in another terminal.",
    });
  }

  if (!response.ok) throw new ApiRequestError(await toApiError(response));

  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiRequestError({
      kind: "server",
      message: `${path} did not return JSON`,
    });
  }
}

export async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiRequestError({ kind: "aborted", message: "request cancelled" });
    }
    throw new ApiRequestError({ kind: "network", message: "Could not reach the API." });
  }
  if (!response.ok) throw new ApiRequestError(await toApiError(response));
  return response.text();
}

export function isRetryable(error: unknown): boolean {
  return asApiError(error).kind === "network";
}

export async function requestUpload<T>(path: string, file: File): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
  } catch {
    throw new ApiRequestError({
      kind: "network",
      message: "The upload could not reach the API.",
    });
  }
  if (!response.ok) throw new ApiRequestError(await toApiError(response));
  return (await response.json()) as T;
}

export async function requestStream(path: string): Promise<ReadableStream<Uint8Array>> {
  let response: Response;
  try {
    response = await fetch(path);
  } catch {
    throw new ApiRequestError({ kind: "network", message: "Could not reach the API." });
  }
  if (!response.ok) throw new ApiRequestError(await toApiError(response));
  if (!response.body) {
    throw new ApiRequestError({ kind: "server", message: `${path} returned no body` });
  }
  return response.body;
}

export async function requestQuietly(path: string, method: "DELETE"): Promise<void> {
  try {
    await fetch(path, { method });
  } catch {
    // Nothing to report: the caller learns the outcome another way.
  }
}
