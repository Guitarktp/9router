import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  getExecutor: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  ProxyAgent: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/models", () => ({
  getProxyPoolById: mocks.getProxyPoolById,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));

vi.mock("@/shared/constants/providers", () => ({
  USAGE_APIKEY_PROVIDERS: [],
}));

vi.mock("undici", () => ({
  ProxyAgent: mocks.ProxyAgent,
}));

const originalFetch = globalThis.fetch;
const RAW_ERROR = "raw proxy token customer-name";

describe("Claude weekend scheduler-safe logging boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    mocks.getProxyPoolById.mockRejectedValue(new Error(RAW_ERROR));
    mocks.ProxyAgent.mockImplementation(function ProxyAgent() {
      throw new Error(RAW_ERROR);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("suppresses resolver error details only when safe logging is requested", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");

    const safeResult = await resolveConnectionProxyConfig(
      { proxyPoolId: "pool-with-sensitive-data" },
      { safeLogging: true },
    );

    expect(safeResult.source).toBe("error");
    expect(error).not.toHaveBeenCalled();

    await resolveConnectionProxyConfig({ proxyPoolId: "pool-with-sensitive-data" });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(" ")).toContain(RAW_ERROR);
  });

  it("uses a silent executor logger only when credential refresh is scheduler-safe", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const refreshCredentials = vi.fn(async (_credentials, logger) => {
      logger.error("TOKEN", RAW_ERROR);
      return null;
    });
    mocks.getExecutor.mockReturnValue({
      needsRefresh: () => true,
      refreshCredentials,
    });
    const { refreshAndUpdateCredentials } = await import(
      "../../src/app/api/usage/[connectionId]/route.js"
    );
    const connection = {
      id: "c1",
      provider: "claude",
      authType: "oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    };

    await refreshAndUpdateCredentials(connection, false, { safeLogging: true });

    expect(error).not.toHaveBeenCalled();

    await refreshAndUpdateCredentials(connection, false, {});

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(" ")).toContain(RAW_ERROR);
  });

  it("suppresses proxy fallback details in safe mode while preserving default diagnostics", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.invalid:8080",
    };

    await proxyAwareFetch("https://example.com/usage", {}, {
      ...proxyOptions,
      safeLogging: true,
    });

    expect(warning).not.toHaveBeenCalled();

    await proxyAwareFetch("https://example.com/usage", {}, proxyOptions);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls.flat().join(" ")).toContain(RAW_ERROR);
  });
});
