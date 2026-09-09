import { isRateLimitError } from "../llm/errors.ts";
import type { ApiErrorDto, ErrorCode } from "./dto.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: Partial<ApiErrorDto["error"]>;

  // Fields assigned explicitly: `erasableSyntaxOnly` bans parameter properties.
  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: Partial<ApiErrorDto["error"]> = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, "not_found", message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, "conflict", message);
}

export function toApiError(error: unknown): { status: number; body: ApiErrorDto } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, ...error.extra } },
    };
  }

  if (isRateLimitError(error)) {
    return {
      status: 429,
      body: {
        error: {
          code: "rate_limited",
          message: error.message,
          retryAfterMs: error.retryAfterMs,
          phase: error.phase,
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: { code: "internal", message } } };
}
