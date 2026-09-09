export interface QuotaSnapshot {
  tokensRemaining: number | null;
  tokensLimit: number | null;
  requestsRemaining: number | null;
  requestsLimit: number | null;
  resetTokensMs: number | null;
  resetRequestsMs: number | null;
}

export interface HeaderBag {
  get(name: string): string | null | undefined;
}

const FALLBACK_RETRY_MS = 60_000;

export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly limitedOn: "tokens" | "requests" | "unknown";
  readonly quota: QuotaSnapshot | null;
  readonly detail: string;
  readonly phase: "rewrite" | "answer" | "unknown";

  constructor(init: {
    retryAfterMs: number;
    limitedOn?: "tokens" | "requests" | "unknown";
    quota?: QuotaSnapshot | null;
    detail?: string;
    phase?: "rewrite" | "answer" | "unknown";
  }) {
    const seconds = (init.retryAfterMs / 1000).toFixed(1);
    super(
      `Groq rate limit hit, so this is a quota problem and not a slow model. ` +
        `Retry in ${seconds}s.` +
        (init.detail ? `\n  ${init.detail}` : ""),
    );
    this.name = "RateLimitError";
    this.retryAfterMs = init.retryAfterMs;
    this.limitedOn = init.limitedOn ?? "unknown";
    this.quota = init.quota ?? null;
    this.detail = init.detail ?? "";
    this.phase = init.phase ?? "unknown";
  }

  withPhase(phase: "rewrite" | "answer"): RateLimitError {
    return new RateLimitError({
      retryAfterMs: this.retryAfterMs,
      limitedOn: this.limitedOn,
      quota: this.quota,
      detail: this.detail,
      phase,
    });
  }
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

export function parseDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim();

  // A bare number is seconds - that is what `Retry-After` means.
  if (/^\d+(\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);

  const parts = /^(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(
    text,
  );
  if (!parts) return null;
  const [, minutes, seconds, millis] = parts;
  if (minutes === undefined && seconds === undefined && millis === undefined) return null;

  const total = Number(minutes ?? 0) * 60_000 + Number(seconds ?? 0) * 1000 + Number(millis ?? 0);
  return Math.ceil(total);
}

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readQuota(headers: HeaderBag | null | undefined): QuotaSnapshot | null {
  if (!headers) return null;
  const snapshot: QuotaSnapshot = {
    tokensRemaining: toNumber(headers.get("x-ratelimit-remaining-tokens")),
    tokensLimit: toNumber(headers.get("x-ratelimit-limit-tokens")),
    requestsRemaining: toNumber(headers.get("x-ratelimit-remaining-requests")),
    requestsLimit: toNumber(headers.get("x-ratelimit-limit-requests")),
    resetTokensMs: parseDuration(headers.get("x-ratelimit-reset-tokens")),
    resetRequestsMs: parseDuration(headers.get("x-ratelimit-reset-requests")),
  };
  const known = Object.values(snapshot).some((value) => value !== null);
  return known ? snapshot : null;
}

export function asRateLimitError(error: unknown): RateLimitError | null {
  if (typeof error !== "object" || error === null) return null;

  const details = error as {
    status?: number;
    headers?: HeaderBag;
    error?: { message?: string };
    message?: string;
  };
  if (details.status !== 429) return null;

  const headers = details.headers;
  const quota = readQuota(headers);
  const detail = details.error?.message ?? details.message ?? "rate limited";

  const fromHeader = parseDuration(headers?.get("retry-after"));

  const resetTokens = quota?.resetTokensMs ?? null;
  const resetRequests = quota?.resetRequestsMs ?? null;

  let limitedOn: "tokens" | "requests" | "unknown" = "unknown";
  let fromReset: number | null = null;
  if (resetTokens !== null && (resetRequests === null || resetTokens >= resetRequests)) {
    limitedOn = "tokens";
    fromReset = resetTokens;
  } else if (resetRequests !== null) {
    limitedOn = "requests";
    fromReset = resetRequests;
  }

  const fromMessage = parseDuration(/try again in ([\d.]+m?s?|[\d.]+ms)/.exec(detail)?.[1]);

  const retryAfterMs = fromHeader ?? fromReset ?? fromMessage ?? FALLBACK_RETRY_MS;

  return new RateLimitError({ retryAfterMs, limitedOn, quota, detail });
}
