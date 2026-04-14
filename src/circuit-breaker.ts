/**
 * Per-service circuit breaker with dynamic cooldown from provider responses.
 *
 * Ported from the Python `coding_agent.router.CircuitBreaker` class.
 * Uses `performance.now()` for monotonic seconds (equivalent to Python's
 * `time.monotonic()`), independent of wall-clock adjustments.
 */

export const CIRCUIT_BREAKER_THRESHOLD = 5;
export const CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC = 300;

function monotonicSec(): number {
  return performance.now() / 1000;
}

export interface CircuitBreakerStatus {
  tripped: boolean;
  failures: number;
  cooldownRemainingSec?: number;
}

export class CircuitBreaker {
  private failures = 0;
  private trippedAt: number | null = null;
  private cooldown: number = CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;

  get isTripped(): boolean {
    if (this.trippedAt === null) {
      return false;
    }
    if (monotonicSec() - this.trippedAt >= this.cooldown) {
      this.reset();
      return false;
    }
    return true;
  }

  recordFailure(retryAfterSec?: number): void {
    this.failures += 1;
    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.trippedAt = monotonicSec();
      this.cooldown =
        retryAfterSec && retryAfterSec > 0
          ? retryAfterSec
          : CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
    }
  }

  recordSuccess(): void {
    this.reset();
  }

  /** Immediately trip — use on 429 or explicit rate-limit response. */
  trip(retryAfterSec?: number): void {
    this.trippedAt = monotonicSec();
    this.cooldown =
      retryAfterSec && retryAfterSec > 0
        ? retryAfterSec
        : CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
  }

  cooldownRemaining(): number {
    if (!this.isTripped || this.trippedAt === null) {
      return 0;
    }
    return Math.max(0, this.cooldown - (monotonicSec() - this.trippedAt));
  }

  status(): CircuitBreakerStatus {
    if (!this.isTripped) {
      return { tripped: false, failures: this.failures };
    }
    return {
      tripped: true,
      failures: this.failures,
      cooldownRemainingSec: Math.round(this.cooldownRemaining() * 10) / 10,
    };
  }

  private reset(): void {
    this.failures = 0;
    this.trippedAt = null;
    this.cooldown = CIRCUIT_BREAKER_DEFAULT_COOLDOWN_SEC;
  }
}
