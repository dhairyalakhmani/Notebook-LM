import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asRateLimitError,
  isRateLimitError,
  parseDuration,
  RateLimitError,
  readQuota,
} from "../src/llm/errors.ts";

function headers(pairs: Record<string, string>) {
  const lower = new Map(Object.entries(pairs).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function throttled(options: { headers?: Record<string, string>; message?: string } = {}) {
  return {
    status: 429,
    headers: options.headers ? headers(options.headers) : undefined,
    error: { message: options.message ?? "Rate limit reached for model" },
  };
}

describe("parseDuration", () => {
  it("reads the formats Groq actually sends", () => {
    assert.equal(parseDuration("7.66s"), 7660);
    assert.equal(parseDuration("120ms"), 120);
    assert.equal(parseDuration("2m59.56s"), 179560);
    assert.equal(parseDuration("1m"), 60_000);
  });

  it("treats a bare number as seconds, which is what Retry-After means", () => {
    assert.equal(parseDuration("30"), 30_000);
    assert.equal(parseDuration("1.5"), 1500);
  });

  it("returns null rather than guessing at an unfamiliar shape", () => {
    assert.equal(parseDuration("soon"), null);
    assert.equal(parseDuration(""), null);
    assert.equal(parseDuration(null), null);
    assert.equal(parseDuration(undefined), null);
  });
});

describe("asRateLimitError", () => {
  it("ignores anything that is not a 429", () => {
    assert.equal(asRateLimitError({ status: 500 }), null);
    assert.equal(asRateLimitError(new Error("network")), null);
    assert.equal(asRateLimitError(undefined), null);
  });

  it("prefers the Retry-After header, which is authoritative", () => {
    const error = asRateLimitError(
      throttled({
        headers: { "retry-after": "12", "x-ratelimit-reset-tokens": "3s" },
        message: "try again in 99s",
      }),
    );
    assert.ok(error);
    assert.equal(error.retryAfterMs, 12_000);
  });

  it("falls back to the reset header, and reports which bucket ran out", () => {
    const error = asRateLimitError(throttled({ headers: { "x-ratelimit-reset-tokens": "7.66s" } }));
    assert.ok(error);
    assert.equal(error.retryAfterMs, 7660);
    assert.equal(error.limitedOn, "tokens");
  });

  it("waits for the longer of the two buckets when both have reset times", () => {
    const error = asRateLimitError(
      throttled({
        headers: { "x-ratelimit-reset-tokens": "2s", "x-ratelimit-reset-requests": "30s" },
      }),
    );
    assert.ok(error);
    assert.equal(error.retryAfterMs, 30_000);
    assert.equal(error.limitedOn, "requests");
  });

  it("scrapes the message when there are no headers at all", () => {
    // This is the case src/eval/runEval.ts used to handle with its own regex.
    const error = asRateLimitError(throttled({ message: "Please try again in 8.5s." }));
    assert.ok(error);
    assert.equal(error.retryAfterMs, 8500);
  });

  it("never hands the caller NaN", () => {
    const error = asRateLimitError(throttled({ message: "slow down" }));
    assert.ok(error);
    assert.ok(Number.isFinite(error.retryAfterMs));
    assert.equal(error.retryAfterMs, 60_000);
  });

  it("is recognisable and keeps the provider's own words", () => {
    const error = asRateLimitError(throttled({ message: "Rate limit reached for gpt-oss" }));
    assert.ok(isRateLimitError(error));
    assert.ok(error instanceof Error);
    assert.match(error.detail, /Rate limit reached/);
    // The message a person sees says what happened and what to do.
    assert.match(error.message, /quota problem and not a slow model/);
    assert.match(error.message, /Retry in 60\.0s/);
  });

  it("carries which of the two LLM calls was throttled", () => {
    const error = asRateLimitError(throttled());
    assert.ok(error);
    assert.equal(error.phase, "unknown");
    const tagged = error.withPhase("rewrite");
    assert.equal(tagged.phase, "rewrite");
    assert.equal(tagged.retryAfterMs, error.retryAfterMs);
    assert.ok(tagged instanceof RateLimitError);
  });
});

describe("readQuota", () => {
  it("reads the headers a successful call also carries", () => {
    const quota = readQuota(
      headers({
        "x-ratelimit-remaining-tokens": "1400",
        "x-ratelimit-limit-tokens": "8000",
        "x-ratelimit-reset-tokens": "34s",
      }),
    );
    assert.ok(quota);
    assert.equal(quota.tokensRemaining, 1400);
    assert.equal(quota.tokensLimit, 8000);
    assert.equal(quota.resetTokensMs, 34_000);
  });

  it("is null when the provider said nothing, rather than all-zeroes", () => {
    // Zeroes would render as "0 of 0 tokens left", which is a lie.
    assert.equal(readQuota(headers({})), null);
    assert.equal(readQuota(null), null);
  });
});
