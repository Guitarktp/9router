import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getApiKeyByValue: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  getApiKeyByValue: mocks.getApiKeyByValue,
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProviderCredentials: mocks.getProviderCredentials,
    markAccountUnavailable: vi.fn(),
    clearAccountError: vi.fn(),
  };
});

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("open-sse/services/combo.js", () => ({
  detectRequiredCapabilities: vi.fn(() => new Set()),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
}));

vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((handler) => handler),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("open-sse/translator/index.js", () => ({
  initTranslators: vi.fn(),
}));

vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: { gemini: [] },
}));

vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(() => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn(() => "gemini") }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/utils/logger.js", () => ({
  $$typeof: undefined,
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "sk-...ogle"),
}));

const { POST } = await import("@/app/api/v1beta/models/[...path]/route.js");

const params = Promise.resolve({ path: ["codex", "gpt-5:generateContent"] });

function geminiRequest({ headerKey, queryKey } = {}) {
  const url = new URL("https://router.test/v1beta/models/codex/gpt-5:generateContent");
  if (queryKey) url.searchParams.set("key", queryKey);

  const headers = { "Content-Type": "application/json" };
  if (headerKey) headers["x-goog-api-key"] = headerKey;

  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    }),
  });
}

describe("API-key routing through the Gemini-compatible route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.getApiKeyByValue.mockImplementation(async (value) => value === "sk-google" ? {
      id: "key-google",
      name: "Google client",
      isActive: true,
      activeProviders: ["claude"],
    } : null);
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "codex-1",
      connectionName: "Codex",
      accessToken: "provider-token",
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleChatCore.mockResolvedValue({
      success: true,
      response: Response.json({
        choices: [{ message: { content: "unexpected" }, finish_reason: "stop" }],
      }),
    });
  });

  it("enforces a required restricted key supplied as x-goog-api-key", async () => {
    const response = await POST(geminiRequest({ headerKey: "sk-google" }), { params });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("provider_not_active_for_api_key");
    expect(mocks.getApiKeyByValue).toHaveBeenCalledWith("sk-google");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("applies an optional recognized restricted key supplied as query key", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });

    const response = await POST(geminiRequest({ queryKey: "sk-google" }), { params });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("provider_not_active_for_api_key");
    expect(mocks.getApiKeyByValue).toHaveBeenCalledWith("sk-google");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("keeps an active key's Codex connection subset after Gemini conversion", async () => {
    mocks.getApiKeyByValue.mockResolvedValue({
      id: "key-google",
      name: "Google client",
      isActive: true,
      activeProviders: ["codex"],
      activeConnections: { codex: ["codex-2"] },
    });

    const response = await POST(geminiRequest({ headerKey: "sk-google" }), { params });

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.any(Set),
      "gpt-5",
      expect.objectContaining({ allowedConnectionIds: new Set(["codex-2"]) }),
    );
  });
});
