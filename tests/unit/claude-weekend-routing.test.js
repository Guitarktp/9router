import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSnapshot: vi.fn(),
}));

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

vi.mock("@/shared/constants/providers.js", async (importOriginal) => ({
  ...(await importOriginal()),
  FREE_PROVIDERS: {},
  resolveProviderId: (providerId) => providerId,
}));

vi.mock("@/shared/services/claudeWeekendRouting/service.js", () => ({
  getClaudeWeekendRoutingSnapshot: mocks.getSnapshot,
}));

vi.mock("@/shared/services/claudeWeekendRouting/policy.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveClaudeWeekendRouting: vi.fn(actual.resolveClaudeWeekendRouting),
  };
});

const SATURDAY = new Date("2026-08-29T05:00:00.000Z");
const MONDAY_SEVEN_AM_BANGKOK = new Date("2026-08-31T00:00:00.000Z");
const OBSERVED_AT = "2026-08-29T04:55:00.000Z";
const RESET_AT = "2026-08-30T12:00:00.000Z";

const connection = (id, priority, overrides = {}) => ({
  id,
  provider: "claude",
  isActive: true,
  priority,
  providerSpecificData: {},
  ...overrides,
});

const snapshotWithEligible = (ids, enabled = true) => ({
  enabled,
  currentlyActive: enabled,
  connections: Object.fromEntries(ids.map((id) => [id, {
    eligible: true,
    reason: "eligible",
    remaining: 42,
    resetAt: RESET_AT,
    observedAt: OBSERVED_AT,
  }])),
});

async function getCredentials(...args) {
  const { getProviderCredentials } = await import("@/sse/services/auth.js");
  return getProviderCredentials(...args);
}

async function getWeekendResolver() {
  const { resolveClaudeWeekendRouting } = await import("@/shared/services/claudeWeekendRouting/policy.js");
  return resolveClaudeWeekendRouting;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(SATURDAY);
  mocks.getSettings.mockResolvedValue({ providerStrategies: {}, fallbackStrategy: "fill-first" });
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  });
  mocks.getProviderConnections.mockImplementation(({ isActive }) => (
    isActive === true
      ? [connection("c1", 1), connection("c2", 2), connection("c3", 3)]
      : [connection("c1", 1), connection("c2", 2), connection("c3", 3)]
  ));
  mocks.getSnapshot.mockReturnValue(snapshotWithEligible(["c2"]));
});

describe("Claude weekend credential routing", () => {
  it("narrows a restricted API key to its eligible Claude connection", async () => {
    const result = await getCredentials("claude", null, "claude-sonnet", {
      allowedConnectionIds: new Set(["c1", "c2"]),
    });

    expect(result.connectionId).toBe("c2");
  });

  it("falls back to a restricted key base set when its eligible intersection is empty", async () => {
    const result = await getCredentials("claude", null, "claude-sonnet", {
      allowedConnectionIds: new Set(["c1"]),
    });

    expect(result.connectionId).toBe("c1");
  });

  it("uses all weekend-eligible globally active Claude connections for an unrestricted key", async () => {
    mocks.getSnapshot.mockReturnValue(snapshotWithEligible(["c2", "c3"]));

    const result = await getCredentials("claude", null, "claude-sonnet");

    expect(result.connectionId).toBe("c2");
  });

  it("never considers a globally inactive connection for weekend eligibility", async () => {
    mocks.getProviderConnections.mockImplementation(({ isActive }) => (
      isActive === true
        ? [connection("c1", 1), connection("c2", 2)]
        : [connection("c1", 1), connection("c2", 2), connection("c3", 3, { isActive: false })]
    ));
    mocks.getSnapshot.mockReturnValue(snapshotWithEligible(["c3"]));

    const result = await getCredentials("claude", null, "claude-sonnet");
    const resolveWeekendRouting = await getWeekendResolver();

    expect(result.connectionId).toBe("c1");
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "claude", isActive: true });
    expect(resolveWeekendRouting).toHaveBeenCalledWith(expect.objectContaining({
      globalConnections: [expect.objectContaining({ id: "c1" }), expect.objectContaining({ id: "c2" })],
    }));
  });

  it("keeps existing routing at Monday 07:00 Bangkok", async () => {
    vi.setSystemTime(MONDAY_SEVEN_AM_BANGKOK);

    const result = await getCredentials("claude", null, "claude-sonnet", {
      allowedConnectionIds: new Set(["c1", "c2"]),
    });

    expect(result.connectionId).toBe("c1");
  });

  it("keeps existing routing when the weekend feature is disabled", async () => {
    mocks.getSnapshot.mockReturnValue(snapshotWithEligible(["c2"], false));

    const result = await getCredentials("claude", null, "claude-sonnet", {
      allowedConnectionIds: new Set(["c1", "c2"]),
    });

    expect(result.connectionId).toBe("c1");
  });

  it("does not invoke the weekend resolver for non-Claude providers", async () => {
    const result = await getCredentials("codex", null, "gpt-5", {
      allowedConnectionIds: new Set(["c1", "c2"]),
    });
    const resolveWeekendRouting = await getWeekendResolver();

    expect(result.connectionId).toBe("c1");
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    expect(resolveWeekendRouting).not.toHaveBeenCalled();
  });

  it("applies retry exclusions after the weekend-eligible set", async () => {
    mocks.getSnapshot.mockReturnValue(snapshotWithEligible(["c2", "c3"]));

    const result = await getCredentials("claude", new Set(["c2"]), "claude-sonnet");

    expect(result.connectionId).toBe("c3");
  });

  it("applies model locks after the weekend-eligible set", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("c1", 1),
      connection("c2", 2, { modelLock_claude_sonnet: "2026-08-30T12:00:00.000Z" }),
      connection("c3", 3),
    ]);
    mocks.getSnapshot.mockReturnValue(snapshotWithEligible(["c2", "c3"]));

    const result = await getCredentials("claude", null, "claude_sonnet");

    expect(result.connectionId).toBe("c3");
  });

  it("keeps round-robin selection inside the weekend-eligible set", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { claude: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 } },
      fallbackStrategy: "fill-first",
    });
    mocks.getProviderConnections.mockResolvedValue([
      connection("c1", 1, { lastUsedAt: "2026-08-29T04:59:00.000Z", consecutiveUseCount: 0 }),
      connection("c2", 2, { lastUsedAt: "2026-08-29T04:58:00.000Z", consecutiveUseCount: 3 }),
      connection("c3", 3, { lastUsedAt: "2026-08-29T04:00:00.000Z", consecutiveUseCount: 0 }),
    ]);
    mocks.getSnapshot.mockReturnValue(snapshotWithEligible(["c2", "c3"]));

    const result = await getCredentials("claude", null, "claude-sonnet");

    expect(result.connectionId).toBe("c3");
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("c3", expect.objectContaining({ consecutiveUseCount: 1 }));
  });
});
