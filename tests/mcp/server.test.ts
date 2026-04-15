/**
 * MCP server smoke tests.
 *
 * Uses the SDK's `InMemoryTransport.createLinkedPair()` so the client and
 * server can exchange JSON-RPC frames entirely in-process, with no real
 * stdio or HTTP.
 */

import { describe, expect, it, vi } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools, TOOL_NAMES } from "../../src/mcp/tools.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { LeaderboardCache } from "../../src/leaderboard.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type {
  DispatchResult,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";

class StubDispatcher implements Dispatcher {
  readonly id: string;
  constructor(id: string, private readonly reply: string) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return { output: this.reply, service: this.id, success: true };
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return true;
  }
}

function makeSvc(name: string, harness: string): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness,
    command: name,
    tier: 1,
    weight: 1.0,
    cliCapability: 1.0,
    capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
    escalateOn: [],
    leaderboardModel: `${name}-model`,
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
  };
}

function stubLeaderboard(): LeaderboardCache {
  const lb = new LeaderboardCache();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lb as any).fetchedAt = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lb as any).data = { "a-model": 1400, "b-model": 1300 };
  return lb;
}

function buildState(): RuntimeState {
  const services = {
    a: makeSvc("a", "claude_code"),
    b: makeSvc("b", "codex"),
  };
  const dispatchers: Record<string, Dispatcher> = {
    a: new StubDispatcher("a", "answer-from-a"),
    b: new StubDispatcher("b", "answer-from-b"),
  };
  const config: RouterConfig = { services };
  const quota = new QuotaCache(dispatchers);
  const leaderboard = stubLeaderboard();
  const router = new Router(config, quota, dispatchers, leaderboard);
  return { config, dispatchers, quota, router, leaderboard, mtimeMs: 0 };
}

// Suppress QuotaCache writes to disk.
vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(() => undefined);

async function startLinked(): Promise<{
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}> {
  const server = new McpServer(
    { name: "coding-agent-mcp-test", version: "test" },
    { instructions: "test server" },
  );
  const holder = new RuntimeHolder(buildState());
  registerTools(server, { holder });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "test" },
    { capabilities: {} },
  );

  await server.connect(serverT);
  await client.connect(clientT);

  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP server — registration", () => {
  it("registers all 10 tools via McpServer.registerTool", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.listTools();
      const names = resp.tools.map((t) => t.name).sort();
      expect(names).toEqual([...TOOL_NAMES].sort());
      // All tools must carry an input schema.
      for (const t of resp.tools) {
        expect(t.inputSchema).toBeDefined();
        expect(t.inputSchema.type).toBe("object");
      }
    } finally {
      await close();
    }
  });

  it("code_auto round-trips through the in-memory transport", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "code_auto",
        arguments: { prompt: "say hi", hints: { taskType: "plan" } },
      });
      expect(resp.isError).not.toBe(true);
      const content = resp.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text) as {
        success: boolean;
        service: string;
        output: string;
        routing?: { tier: number };
      };
      expect(parsed.success).toBe(true);
      // Our two stub services both sit in tier 1 — the higher-ELO
      // leaderboard model wins.
      expect(["a", "b"]).toContain(parsed.service);
      expect(parsed.output.length).toBeGreaterThan(0);
      expect(parsed.routing).toBeDefined();
    } finally {
      await close();
    }
  });

  it("list_available_services returns services in the JSON block", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "list_available_services",
        arguments: {},
      });
      const content = resp.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        services: Array<{ name: string; maxOutputTokens?: number }>;
      };
      expect(parsed.services.map((s) => s.name).sort()).toEqual(["a", "b"]);
      for (const s of parsed.services) {
        expect(s.maxOutputTokens).toBeDefined();
      }
    } finally {
      await close();
    }
  });

  it("dashboard returns a text content block", async () => {
    const { client, close } = await startLinked();
    try {
      const resp = await client.callTool({
        name: "dashboard",
        arguments: {},
      });
      const content = resp.content as Array<{ type: string; text: string }>;
      expect(content[0]!.type).toBe("text");
      expect(content[0]!.text).toContain("coding-agent-mcp");
    } finally {
      await close();
    }
  });
});
