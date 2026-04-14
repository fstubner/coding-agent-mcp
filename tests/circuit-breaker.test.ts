import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC,
  CIRCUIT_BREAKER_THRESHOLD,
  CircuitBreaker,
} from "../src/circuit-breaker.js";

/**
 * Stub `performance.now()` with a mutable counter so we can simulate time
 * advancement deterministically. CircuitBreaker reads `performance.now() / 1000`.
 */
let nowMs = 0;

beforeEach(() => {
  nowMs = 1_000_000; // arbitrary starting point, non-zero so we can detect state changes
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function advanceSec(sec: number): void {
  nowMs += sec * 1000;
}

describe("CircuitBreaker", () => {
  it("starts untripped with zero failures", () => {
    const cb = new CircuitBreaker();
    expect(cb.isTripped).toBe(false);
    expect(cb.status()).toEqual({ tripped: false, failures: 0 });
    expect(cb.cooldownRemaining()).toBe(0);
  });

  it("trips after threshold failures with default cooldown", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(true);
    const status = cb.status();
    expect(status.tripped).toBe(true);
    expect(status.failures).toBe(CIRCUIT_BREAKER_THRESHOLD);
    expect(status.cooldownRemainingSec).toBeGreaterThan(0);
    expect(status.cooldownRemainingSec).toBeLessThanOrEqual(
      CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC,
    );
  });

  it("auto-resets when cooldown expires", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(true);

    advanceSec(CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC + 1);

    expect(cb.isTripped).toBe(false);
    // After the reset the status should reflect zero failures.
    expect(cb.status()).toEqual({ tripped: false, failures: 0 });
  });

  it("trip(retryAfterSec) honours the provided cooldown", () => {
    const cb = new CircuitBreaker();
    cb.trip(42);
    expect(cb.isTripped).toBe(true);
    // Right after trip(), cooldownRemaining() should be close to 42.
    const remaining = cb.cooldownRemaining();
    expect(remaining).toBeGreaterThan(41);
    expect(remaining).toBeLessThanOrEqual(42);

    advanceSec(43);
    expect(cb.isTripped).toBe(false);
  });

  it("trip() falls back to default when retryAfter is missing / non-positive", () => {
    const cb = new CircuitBreaker();
    cb.trip();
    expect(cb.cooldownRemaining()).toBeGreaterThan(
      CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC - 1,
    );

    const cb2 = new CircuitBreaker();
    cb2.trip(-5);
    expect(cb2.cooldownRemaining()).toBeGreaterThan(
      CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC - 1,
    );
  });

  it("recordFailure(retryAfterSec) uses retryAfter when threshold is crossed", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(false);
    cb.recordFailure(77);
    expect(cb.isTripped).toBe(true);
    const remaining = cb.cooldownRemaining();
    expect(remaining).toBeGreaterThan(75);
    expect(remaining).toBeLessThanOrEqual(77);
  });

  it("recordSuccess resets failure counter", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.status().failures).toBe(3);
    cb.recordSuccess();
    expect(cb.status()).toEqual({ tripped: false, failures: 0 });
  });

  it("recordFailure below threshold keeps the breaker closed", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD - 1; i += 1) {
      cb.recordFailure();
    }
    expect(cb.isTripped).toBe(false);
    expect(cb.status().failures).toBe(CIRCUIT_BREAKER_THRESHOLD - 1);
  });
});
