/**
 * HTTP rate-limit header parsers.
 *
 * Ported from `src/coding_agent/dispatchers/utils.py` (parse_remaining,
 * parse_limit, parse_retry_after). Preserves the same key order and semantics:
 * - matching is case-insensitive (headers are normalized to lowercase)
 * - numeric strings with commas are NOT supported here (matches Python)
 * - Retry-After may be a delta-seconds number or an HTTP-date
 * - reset-* headers may be an epoch timestamp (seconds since 1970)
 */

const REMAINING_KEYS = [
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-remaining",
  "ratelimit-remaining",
] as const;

const LIMIT_KEYS = [
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-tokens-limit",
  "ratelimit-limit",
] as const;

const RETRY_AFTER_KEYS = [
  "retry-after",
  "x-ratelimit-retry-after",
] as const;

const RESET_EPOCH_KEYS = [
  "x-ratelimit-reset",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

/**
 * Normalize to lowercase keys so lookups are case-insensitive.
 * Later duplicates win (matches typical HTTP proxy behavior).
 */
function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function parseIntStrict(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Python's int() rejects decimals; match that.
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatStrict(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number.parseFloat(trimmed);
  if (!Number.isFinite(n)) return null;
  // Reject obvious non-numeric prefixes like "soon"/"5min".
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return null;
  return n;
}

export function parseRemaining(headers: Record<string, string>): number | null {
  const h = lower(headers);
  for (const key of REMAINING_KEYS) {
    const v = parseIntStrict(h[key]);
    if (v !== null) return v;
  }
  return null;
}

export function parseLimit(headers: Record<string, string>): number | null {
  const h = lower(headers);
  for (const key of LIMIT_KEYS) {
    const v = parseIntStrict(h[key]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Returns retry-after in seconds (fractional allowed). Sources in priority order:
 *   1. Retry-After or x-ratelimit-retry-after as delta-seconds
 *   2. Retry-After as an HTTP-date (RFC 7231)
 *   3. x-ratelimit-reset{,-requests,-tokens} as an epoch timestamp
 *
 * Returns null if no header is present or all are malformed.
 */
export function parseRetryAfter(headers: Record<string, string>): number | null {
  const h = lower(headers);

  // 1. delta-seconds
  for (const key of RETRY_AFTER_KEYS) {
    const v = parseFloatStrict(h[key]);
    if (v !== null) return v;
  }

  // 2. HTTP-date (only Retry-After permits this per RFC 7231 §7.1.3)
  const retryAfter = h["retry-after"];
  if (retryAfter && retryAfter.trim() !== "") {
    const ts = Date.parse(retryAfter);
    if (Number.isFinite(ts)) {
      const delay = (ts - Date.now()) / 1000;
      return Math.max(0, delay);
    }
  }

  // 3. epoch reset
  for (const key of RESET_EPOCH_KEYS) {
    const epoch = parseFloatStrict(h[key]);
    if (epoch !== null) {
      const delay = epoch - Date.now() / 1000;
      return Math.max(0, delay);
    }
  }

  return null;
}
