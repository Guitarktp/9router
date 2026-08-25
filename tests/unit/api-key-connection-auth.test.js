import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
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

vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: { "no-auth": { noAuth: true } },
  resolveProviderId: (providerId) => providerId,
}));

const connection = (id, priority) => ({
  id,
  provider: "claude",
  isActive: true,
  priority,
  providerSpecificData: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ providerStrategies: {}, fallbackStrategy: "fill-first" });
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  });
  mocks.getProviderConnections.mockResolvedValue([
    connection("claude-1", 1),
    connection("claude-2", 2),
  ]);
});

describe("API-key connection credential policy", () => {
  it("filters globally active connections before selection", async () => {
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    const result = await getProviderCredentials("claude", null, "opus", {
      allowedConnectionIds: new Set(["claude-2"]),
    });

    expect(result.connectionId).toBe("claude-2");
  });

  it("denies credential selection for an explicit empty connection policy", async () => {
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    const result = await getProviderCredentials("claude", null, "opus", {
      allowedConnectionIds: new Set(),
    });

    expect(result).toBeNull();
  });

  it("does not select a preferred connection outside the allowed policy", async () => {
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    const result = await getProviderCredentials("claude", null, "opus", {
      preferredConnectionId: "claude-1",
      allowedConnectionIds: new Set(["claude-2"]),
    });

    expect(result.connectionId).toBe("claude-2");
  });

  it("retains global credential selection when no connection policy is supplied", async () => {
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    const result = await getProviderCredentials("claude", null, "opus");

    expect(result.connectionId).toBe("claude-1");
  });

  it("returns the no-auth virtual credential without querying stored connections", async () => {
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    const result = await getProviderCredentials("no-auth", null, "model", {
      allowedConnectionIds: new Set(),
    });

    expect(result.id).toBe("noauth");
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });
});
