import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupProviderConnections: vi.fn(),
  configureClaudeWeekendRouting: vi.fn(),
  getApiKeys: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getSnapshot: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  cleanupProviderConnections: mocks.cleanupProviderConnections,
  getApiKeys: mocks.getApiKeys,
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

vi.mock("@/lib/mcp/stdioSseBridge", () => ({
  killAllBridges: vi.fn(),
}));

vi.mock("@/mitm/manager", () => ({
  getMitmStatus: vi.fn(),
  initDbHooks: vi.fn(),
  loadEncryptedPassword: vi.fn(),
  removeAllDNSEntriesSync: vi.fn(),
  restoreToolDNS: vi.fn(),
  startMitm: vi.fn(),
}));

vi.mock("@/lib/mitmAliasCache", () => ({ syncToJson: vi.fn() }));

vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}), { virtual: true });

vi.mock("bcryptjs", () => ({ default: {} }));

vi.mock("@/shared/services/claudeWeekendRouting/service.js", () => ({
  configureClaudeWeekendRouting: mocks.configureClaudeWeekendRouting,
  getClaudeWeekendRoutingSnapshot: mocks.getSnapshot,
}));

const ACTIVE_NOW = new Date("2026-08-29T05:00:00.000Z");
const SNAPSHOT = Object.freeze({
  generation: 99,
  enabled: true,
  currentlyActive: true,
  windowStartAt: "2026-08-28T17:00:00.000Z",
  windowEndAt: "2026-08-31T00:00:00.000Z",
  lastCompletedAt: "2026-08-29T05:00:00.000Z",
  connections: Object.freeze({
    c1: Object.freeze({
      eligible: true,
      reason: "eligible",
      remaining: 42,
      resetAt: "2026-08-30T12:00:00.000Z",
      observedAt: "2026-08-29T05:00:00.000Z",
      accessToken: "must-not-leak",
      refreshToken: "must-not-leak",
    }),
    c2: Object.freeze({
      eligible: false,
      reason: "weekly_exhausted",
      remaining: 0,
      observedAt: "2026-08-29T05:00:00.000Z",
      apiKey: "must-not-leak",
      proxy: "must-not-leak",
    }),
  }),
});

function safeAndSecretConnection(id, isActive = true) {
  return {
    id,
    provider: "claude",
    isActive,
    name: "must-not-leak",
    accessToken: "must-not-leak",
    refreshToken: "must-not-leak",
    apiKey: "must-not-leak",
    providerSpecificData: { proxy: "must-not-leak" },
  };
}

describe("Claude weekend routing settings and status API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ACTIVE_NOW);
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ claudeWeekendRouting: { enabled: true } });
    mocks.updateSettings.mockResolvedValue({
      claudeWeekendRouting: { enabled: false },
    });
    mocks.getSnapshot.mockReturnValue(SNAPSHOT);
    mocks.getProviderConnections.mockResolvedValue([
      safeAndSecretConnection("c1"),
      safeAndSecretConnection("c2"),
    ]);
    mocks.getApiKeys.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("defaults Claude weekend routing to enabled when the setting is missing", async () => {
    const { mergeWithDefaults } = await import("@/lib/db/repos/settingsRepo.js");

    expect(mergeWithDefaults({}).claudeWeekendRouting).toEqual({ enabled: true });
  });

  it("configures Claude weekend routing with merged settings during startup", async () => {
    const { initializeApp } = await import("@/shared/services/initializeApp.js");

    await initializeApp();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.dynamicImportSettled();

    expect(mocks.configureClaudeWeekendRouting).toHaveBeenCalledWith({
      claudeWeekendRouting: { enabled: true },
    });
  });

  it("reconfigures Claude weekend routing immediately after its saved setting changes", async () => {
    const { PATCH } = await import("@/app/api/settings/route.js");
    const savedSettings = { claudeWeekendRouting: { enabled: false } };
    mocks.updateSettings.mockResolvedValue(savedSettings);

    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ claudeWeekendRouting: { enabled: false } }),
    }));
    await vi.dynamicImportSettled();

    expect(response.status).toBe(200);
    expect(mocks.configureClaudeWeekendRouting).toHaveBeenCalledWith(savedSettings);
  });

  it("returns an allowlisted Global status without a per-key mode", async () => {
    const { GET } = await import("@/app/api/providers/claude/weekend-routing/route.js");

    const response = await GET(new Request("http://localhost/api/providers/claude/weekend-routing"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("mode");
    expect(body).toMatchObject({
      enabled: true,
      currentlyActive: true,
      hasEligibleConnections: true,
      windowStartAt: "2026-08-28T17:00:00.000Z",
      windowEndAt: "2026-08-31T00:00:00.000Z",
      lastCompletedAt: "2026-08-29T05:00:00.000Z",
    });
    expect(body.connections.c1).toEqual({
      eligible: true,
      reason: "eligible",
      remaining: 42,
      resetAt: "2026-08-30T12:00:00.000Z",
      observedAt: "2026-08-29T05:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|apiKey|proxy|name/i);
  });

  it("returns filtered mode for an API key with eligible selected Claude connections", async () => {
    const { GET } = await import("@/app/api/providers/claude/weekend-routing/route.js");
    mocks.getApiKeys.mockResolvedValue([{
      id: "key-filtered",
      activeConnections: { claude: ["c1", "c2"] },
    }]);

    const response = await GET(new Request("http://localhost/api/providers/claude/weekend-routing?apiKeyId=key-filtered"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("filtered");
    expect(body.hasEligibleConnections).toBe(true);
  });

  it("returns fallback mode for an API key whose selected Claude connections have no eligibility", async () => {
    const { GET } = await import("@/app/api/providers/claude/weekend-routing/route.js");
    mocks.getApiKeys.mockResolvedValue([{
      id: "key-fallback",
      activeConnections: { claude: ["c2"] },
    }]);

    const response = await GET(new Request("http://localhost/api/providers/claude/weekend-routing?apiKeyId=key-fallback"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("fallback");
    expect(body.hasEligibleConnections).toBe(false);
  });

  it("returns 404 for an unknown API key ID", async () => {
    const { GET } = await import("@/app/api/providers/claude/weekend-routing/route.js");

    const response = await GET(new Request("http://localhost/api/providers/claude/weekend-routing?apiKeyId=missing"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Key not found" });
  });
});
