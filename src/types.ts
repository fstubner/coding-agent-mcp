/**
 * Core types for coding-agent-mcp.
 *
 * These are the cross-cutting types used by dispatchers, the router, the
 * quota tracker, and the MCP surface. Downstream modules (R2/R3/R4) import
 * from here.
 */

export type TaskType = "execute" | "plan" | "review" | "local" | "";

export type ThinkingLevel = "low" | "medium" | "high";

export interface DispatchResult {
  output: string;
  service: string;
  success: boolean;
  error?: string;
  rateLimited?: boolean;
  retryAfter?: number;
  rateLimitHeaders?: Record<string, string>;
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
}

export interface QuotaInfo {
  service: string;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  source: "headers" | "api" | "unknown";
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  type: "cli" | "openai_compatible";
  harness?: string;
  command?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  tier: number;
  weight: number;
  cliCapability: number;
  leaderboardModel?: string;
  thinkingLevel?: ThinkingLevel;
  escalateModel?: string;
  escalateOn: TaskType[];
  capabilities: Partial<Record<"execute" | "plan" | "review", number>>;
}

export interface RouterConfig {
  services: Record<string, ServiceConfig>;
  geminiApiKey?: string;
  disabled?: readonly string[];
}

export interface RoutingDecision {
  service: string;
  tier: number;
  quotaScore: number;
  qualityScore: number;
  cliCapability: number;
  capabilityScore: number;
  taskType: TaskType;
  model: string | undefined;
  elo: number | undefined;
  finalScore: number;
  reason: string;
}

export interface RouteHints {
  service?: string;
  preferLargeContext?: boolean;
  taskType?: TaskType;
  harness?: string;
}

export type DispatcherEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "thinking"; chunk: string }
  | { type: "completion"; result: DispatchResult }
  | { type: "error"; error: string };
