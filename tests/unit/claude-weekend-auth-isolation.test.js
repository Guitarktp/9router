import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
  openSseLoaded: false,
}));

vi.mock("open-sse/index.js", () => {
  mocks.openSseLoaded = true;
  globalThis.fetch = vi.fn();
  return {};
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  updateProviderConnection: mocks.updateProviderConnection,
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsageObservation: vi.fn(),
}));

vi.mock("@/shared/constants/config", () => ({
  CLAUDE_WEEKEND_ROUTING_CONFIG: { maxObservationAgeMs: 15 * 60 * 1000 },
}));

vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (providerId) => providerId,
}));

const SATURDAY = new Date("2026-08-29T05:00:00.000Z");

const connection = (id, priority) => ({
  id,
  provider: "claude",
  isActive: true,
  priority,
  providerSpecificData: {},
});

function snapshot({ enabled, connections = {} }) {
  return Object.freeze({
    generation: 1,
    enabled,
    currentlyActive: enabled,
    lastCompletedAt: null,
    windowStartAt: "2026-08-28T17:00:00.000Z",
    windowEndAt: "2026-08-31T00:00:00.000Z",
    connections: Object.freeze(connections),
  });
}

describe("Claude weekend auth snapshot isolation", () => {
  let originalFetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(SATURDAY);
    originalFetch = globalThis.fetch;
    mocks.openSseLoaded = false;
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, fallbackStrategy: "fill-first" });
    mocks.getProxyPools.mockResolvedValue([]);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: null,
      vercelRelayUrl: "",
    });
    mocks.getProviderConnections.mockResolvedValue([connection("c1", 1), connection("c2", 2)]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete global.__claudeWeekendRouting;
    vi.useRealTimers();
  });

  it("uses an inactive snapshot on the first Claude selection without scheduler imports", async () => {
    global.__claudeWeekendRouting = {
      interval: null,
      running: false,
      rerunRequested: false,
      generation: 1,
      snapshot: snapshot({ enabled: false }),
    };

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const result = await getProviderCredentials("claude", null, "claude-sonnet", {
      allowedConnectionIds: new Set(["c1", "c2"]),
    });

    expect(result.connectionId).toBe("c1");
    expect(mocks.openSseLoaded).toBe(false);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("falls back to the API-key base set on the first Claude selection without scheduler imports", async () => {
    global.__claudeWeekendRouting = {
      interval: null,
      running: false,
      rerunRequested: false,
      generation: 1,
      snapshot: snapshot({ enabled: true }),
    };

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const result = await getProviderCredentials("claude", null, "claude-sonnet", {
      allowedConnectionIds: new Set(["c1"]),
    });

    expect(result.connectionId).toBe("c1");
    expect(mocks.openSseLoaded).toBe(false);
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
