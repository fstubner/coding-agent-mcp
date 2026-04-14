import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseLimit,
  parseRemaining,
  parseRetryAfter,
} from "../src/dispatchers/shared/rate-limit-headers.js";

describe("parseRemaining", () => {
  it("returns null for empty headers", () => {
    expect(parseRemaining({})).toBeNull();
  });

  it("returns null when only unrelated keys are present", () => {
    expect(parseRemaining({ "content-type": "application/json" })).toBeNull();
  });

  it("parses x-ratelimit-remaining-requests", () => {
    expect(
      parseRemaining({ "x-ratelimit-remaining-requests": "42" }),
    ).toBe(42);
  });

  it("parses x-ratelimit-remaining as fallback", () => {
    expect(parseRemaining({ "x-ratelimit-remaining": "7" })).toBe(7);
  });

  it("parses anthropic-ratelimit-requests-remaining", () => {
    expect(
      parseRemaining({ "anthropic-ratelimit-requests-remaining": "100" }),
    ).toBe(100);
  });

  it("is case-insensitive on header names (mixed case)", () => {
    expect(parseRemaining({ "X-RateLimit-Remaining": "13" })).toBe(13);
    expect(parseRemaining({ "X-RATELIMIT-REMAINING-REQUESTS": "5" })).toBe(5);
  });

  it("prefers the more-specific -requests variant over the generic key", () => {
    expect(
      parseRemaining({
        "x-ratelimit-remaining-requests": "99",
        "x-ratelimit-remaining": "1",
      }),
    ).toBe(99);
  });

  it("handles zero correctly (not treated as falsy)", () => {
    expect(parseRemaining({ "x-ratelimit-remaining": "0" })).toBe(0);
  });

  it("returns null for malformed values", () => {
    expect(parseRemaining({ "x-ratelimit-remaining": "unlimited" })).toBeNull();
    expect(parseRemaining({ "x-ratelimit-remaining": "3.14" })).toBeNull();
    expect(parseRemaining({ "x-ratelimit-remaining": "" })).toBeNull();
  });

  it("skips malformed values and tries the next candidate", () => {
    expect(
      parseRemaining({
        "x-ratelimit-remaining-requests": "junk",
        "x-ratelimit-remaining": "11",
      }),
    ).toBe(11);
  });
});

describe("parseLimit", () => {
  it("returns null for empty headers", () => {
    expect(parseLimit({})).toBeNull();
  });

  it("parses x-ratelimit-limit-requests", () => {
    expect(parseLimit({ "x-ratelimit-limit-requests": "1000" })).toBe(1000);
  });

  it("parses x-ratelimit-limit as fallback", () => {
    expect(parseLimit({ "x-ratelimit-limit": "500" })).toBe(500);
  });

  it("parses anthropic-ratelimit-requests-limit", () => {
    expect(
      parseLimit({ "anthropic-ratelimit-requests-limit": "4000" }),
    ).toBe(4000);
  });

  it("is case-insensitive on header names", () => {
    expect(parseLimit({ "X-RateLimit-Limit": "250" })).toBe(250);
  });

  it("returns null for malformed values", () => {
    expect(parseLimit({ "x-ratelimit-limit": "∞" })).toBeNull();
  });
});

describe("parseRetryAfter — delta-seconds", () => {
  it("returns null for empty headers", () => {
    expect(parseRetryAfter({})).toBeNull();
  });

  it("parses Retry-After as an integer number of seconds", () => {
    expect(parseRetryAfter({ "retry-after": "30" })).toBe(30);
  });

  it("parses Retry-After as a fractional number of seconds", () => {
    expect(parseRetryAfter({ "retry-after": "2.5" })).toBeCloseTo(2.5, 5);
  });

  it("is case-insensitive on header names", () => {
    expect(parseRetryAfter({ "Retry-After": "15" })).toBe(15);
    expect(parseRetryAfter({ "RETRY-AFTER": "20" })).toBe(20);
  });

  it("parses x-ratelimit-retry-after as a fallback delta-seconds source", () => {
    expect(parseRetryAfter({ "x-ratelimit-retry-after": "45" })).toBe(45);
  });

  it("prefers Retry-After over x-ratelimit-retry-after", () => {
    expect(
      parseRetryAfter({
        "retry-after": "10",
        "x-ratelimit-retry-after": "99",
      }),
    ).toBe(10);
  });
});

describe("parseRetryAfter — HTTP-date", () => {
  beforeEach(() => {
    // Pin "now" to 2026-04-14T12:00:00Z so HTTP-date arithmetic is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses an HTTP-date Retry-After value into a positive delta", () => {
    const result = parseRetryAfter({
      "retry-after": "Tue, 14 Apr 2026 12:01:00 GMT",
    });
    expect(result).toBeCloseTo(60, 1);
  });

  it("clamps past HTTP-dates to 0 (no negative retry-after)", () => {
    const result = parseRetryAfter({
      "retry-after": "Tue, 14 Apr 2026 11:59:00 GMT",
    });
    expect(result).toBe(0);
  });
});

describe("parseRetryAfter — epoch reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-04-14T12:00:00Z == 1776513600 epoch seconds
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses x-ratelimit-reset as an epoch timestamp in seconds", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const headers = { "x-ratelimit-reset": String(nowSec + 120) };
    expect(parseRetryAfter(headers)).toBeCloseTo(120, 1);
  });

  it("parses x-ratelimit-reset-requests", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const headers = { "x-ratelimit-reset-requests": String(nowSec + 90) };
    expect(parseRetryAfter(headers)).toBeCloseTo(90, 1);
  });

  it("parses x-ratelimit-reset-tokens", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const headers = { "x-ratelimit-reset-tokens": String(nowSec + 45) };
    expect(parseRetryAfter(headers)).toBeCloseTo(45, 1);
  });

  it("clamps past epoch values to 0", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(parseRetryAfter({ "x-ratelimit-reset": String(nowSec - 500) })).toBe(
      0,
    );
  });

  it("prefers delta-seconds Retry-After over epoch reset", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = parseRetryAfter({
      "retry-after": "5",
      "x-ratelimit-reset": String(nowSec + 9999),
    });
    expect(result).toBe(5);
  });
});

describe("parseRetryAfter — malformed", () => {
  it("returns null when Retry-After is an unparseable string", () => {
    expect(parseRetryAfter({ "retry-after": "soon" })).toBeNull();
  });

  it("returns null for an empty string value", () => {
    expect(parseRetryAfter({ "retry-after": "" })).toBeNull();
  });

  it("falls through to the next key when one is malformed", () => {
    expect(
      parseRetryAfter({
        "retry-after": "bogus",
        "x-ratelimit-retry-after": "12",
      }),
    ).toBe(12);
  });
});
