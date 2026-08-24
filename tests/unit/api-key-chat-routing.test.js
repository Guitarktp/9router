import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  isProviderActive: vi.fn(),
  filterModelCandidates: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  augmentModelsWithCapacityAdapter: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => "sk-pegasus"),
  isValidApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("@/sse/services/apiKeyRouting.js", () => ({
  resolveApiKeyRoutingContext: mocks.resolveContext,
  isProviderActive: mocks.isProviderActive,
  filterModelCandidates: mocks.filterModelCandidates,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("open-sse/services/combo.js", () => ({
  detectRequiredCapabilities: vi.fn(() => new Set()),
  handleComboChat: mocks.handleComboChat,
  handleFusionChat: mocks.handleFusionChat,
}));

vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: mocks.augmentModelsWithCapacityAdapter,
  withCapacityAdapterStripping: vi.fn((handler) => handler),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(() => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn(() => "openai") }));
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
  maskKey: vi.fn(() => "sk-...asus"),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");

function restricted(activeProviders) {
  return {
    ok: true,
    mode: "restricted",
    key: { id: "key-1", name: "Pegasus" },
    activeProviders: new Set(activeProviders),
  };
}

function chatRequest(body) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer sk-pegasus",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], ...body }),
  });
}

function providerFor(model) {
  if (model.startsWith("cc/")) return "claude";
  if (model.startsWith("cx/")) return "codex";
  return null;
}

async function routedComboModels(models, activeProviders) {
  mocks.resolveContext.mockResolvedValue(restricted(activeProviders));
  mocks.getComboModels.mockImplementation(async (model) => model === "combo" ? models : null);

  const response = await handleChat(chatRequest({ model: "combo" }));
  return (await response.json()).models;
}

describe("API key chat provider routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.resolveContext.mockResolvedValue(restricted(["claude", "codex"]));
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockImplementation(async (model) => ({
      provider: providerFor(model),
      model: model.split("/").slice(1).join("/"),
    }));
    mocks.isProviderActive.mockImplementation(
      (context, provider) => context.mode === "unrestricted" || context.activeProviders.has(provider),
    );
    mocks.filterModelCandidates.mockImplementation(async (models, context) => {
      if (context.mode === "unrestricted") return models;
      const allowed = [];
      for (const model of models) {
        const { provider } = await mocks.getModelInfo(model);
        if (context.activeProviders.has(provider)) allowed.push(model);
      }
      return allowed;
    });
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "c1",
      connectionName: "Primary",
      accessToken: "token",
    });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleChatCore.mockResolvedValue({
      success: true,
      response: Response.json({ ok: true }),
    });
    mocks.handleComboChat.mockImplementation(async ({ models }) => Response.json({ models }));
    mocks.handleFusionChat.mockImplementation(async ({ body, handleSingleModel, judgeModel }) => (
      handleSingleModel(body, judgeModel)
    ));
  });

  it("rejects a direct inactive provider before credential selection", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });

    const response = await handleChat(chatRequest({ model: "cx/gpt-5" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("provider_not_active_for_api_key");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("keeps active direct-provider dispatch and raw-key attribution unchanged", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["codex"]));
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });

    const response = await handleChat(chatRequest({ model: "cx/gpt-5" }));

    expect(response.status).toBe(200);
    expect(mocks.resolveContext).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-pegasus" }));
  });

  it("filters inactive providers from a combo before dispatch", async () => {
    expect(await routedComboModels(["cc/a", "cx/b", "cc/c"], ["claude"]))
      .toEqual(["cc/a", "cc/c"]);
  });

  it("rejects a combo with no active providers before combo or credential dispatch", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.getComboModels.mockImplementation(async (model) => (
      model === "combo" ? ["cx/a", "cx/b"] : null
    ));

    const response = await handleChat(chatRequest({ model: "combo" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("no_active_combo_providers_for_api_key");
    expect(mocks.handleComboChat).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("removes an inactive capacity adapter while retaining the authorized requested provider", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.augmentModelsWithCapacityAdapter.mockReturnValue(["cc/a", "cx/vision-adapter"]);

    const response = await handleChat(chatRequest({ model: "cc/a" }));

    expect(response.status).toBe(200);
    expect(mocks.handleComboChat.mock.calls.length).toBe(0);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("claude", expect.any(Set), "a");
  });

  it("applies the same filtering when a combo resolves inside single-model dispatch", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: {
        outer: { fallbackStrategy: "fusion", judgeModel: "nested" },
      },
    });
    mocks.getComboModels.mockImplementation(async (model) => {
      if (model === "outer") return ["cc/panel-a", "cc/panel-b"];
      if (model === "nested") return ["cc/a", "cx/b"];
      return null;
    });

    const response = await handleChat(chatRequest({ model: "outer" }));

    expect(await response.json()).toEqual({ models: ["cc/a"] });
  });

  it("rejects an inactive fusion judge through the final direct guard", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: {
        fusion: { fallbackStrategy: "fusion", judgeModel: "cx/judge" },
      },
    });
    mocks.getComboModels.mockImplementation(async (model) => (
      model === "fusion" ? ["cc/a", "cc/b"] : null
    ));

    const response = await handleChat(chatRequest({ model: "fusion" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("provider_not_active_for_api_key");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});
