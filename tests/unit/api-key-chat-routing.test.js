import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  isProviderActive: vi.fn(),
  getAllowedConnectionIds: vi.fn(),
  filterModelCandidates: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  handleChatCore: vi.fn(),
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  handleBypassRequest: vi.fn(),
  augmentModelsWithCapacityAdapter: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
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
  getAllowedConnectionIds: mocks.getAllowedConnectionIds,
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
  handleBypassRequest: mocks.handleBypassRequest,
}));

vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(() => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/translator/formats.js", async (importOriginal) => ({
  ...(await importOriginal()),
  detectFormatByEndpoint: vi.fn(() => "openai"),
}));
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
    mocks.getAllowedConnectionIds.mockImplementation((context, provider) => {
      const configured = context.activeConnections?.[provider];
      return Array.isArray(configured) ? new Set(configured) : null;
    });
    mocks.filterModelCandidates.mockImplementation(async (models, context) => {
      if (context.mode === "unrestricted") return models;
      const allowed = [];
      for (const model of models) {
        const { provider } = await mocks.getModelInfo(model);
        if (context.activeProviders.has(provider)) allowed.push(model);
      }
      return allowed;
    });
    mocks.handleBypassRequest.mockReturnValue(null);
    mocks.augmentModelsWithCapacityAdapter.mockImplementation((models) => models);
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "c1",
      connectionName: "Primary",
      accessToken: "token",
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
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

  it("authorizes an inactive direct provider before considering a synthetic bypass", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });
    mocks.handleBypassRequest.mockReturnValue({
      response: Response.json({ synthetic: true }),
    });

    const response = await handleChat(chatRequest({ model: "cx/gpt-5" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("provider_not_active_for_api_key");
    expect(mocks.handleBypassRequest).not.toHaveBeenCalled();
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

  it("uses the selected subset on every retry", async () => {
    mocks.resolveContext.mockResolvedValue({
      ...restricted(["claude"]),
      activeConnections: { claude: ["claude-2", "claude-4"] },
    });
    mocks.getModelInfo.mockResolvedValue({ provider: "claude", model: "opus" });
    mocks.getProviderCredentials
      .mockResolvedValueOnce({ connectionId: "claude-2", connectionName: "Two", accessToken: "t2" })
      .mockResolvedValueOnce({ connectionId: "claude-4", connectionName: "Four", accessToken: "t4" });
    mocks.handleChatCore
      .mockResolvedValueOnce({ success: false, status: 429, error: "limited" })
      .mockResolvedValueOnce({ success: true, response: Response.json({ ok: true }) });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });

    const response = await handleChat(chatRequest({ model: "cc/opus" }));

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    const allowlists = mocks.getProviderCredentials.mock.calls.map((call) => call[3].allowedConnectionIds);
    expect(allowlists.map((allowed) => [...allowed])).toEqual([
      ["claude-2", "claude-4"],
      ["claude-2", "claude-4"],
    ]);
    expect(allowlists[1]).toBe(allowlists[0]);
  });

  it("keeps each combo provider within its selected connection subset", async () => {
    mocks.resolveContext.mockResolvedValue({
      ...restricted(["claude", "codex"]),
      activeConnections: { claude: ["claude-2"], codex: ["codex-7"] },
    });
    mocks.getComboModels.mockImplementation(async (model) => (
      model === "combo" ? ["cc/opus", "cx/gpt-5"] : null
    ));
    mocks.handleComboChat.mockImplementation(async ({ body, models, handleSingleModel }) => {
      let response;
      for (const model of models) response = await handleSingleModel(body, model);
      return response;
    });

    const response = await handleChat(chatRequest({ model: "combo" }));

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "claude",
      expect.any(Set),
      "opus",
      expect.objectContaining({ allowedConnectionIds: new Set(["claude-2"]) }),
    );
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "codex",
      expect.any(Set),
      "gpt-5",
      expect.objectContaining({ allowedConnectionIds: new Set(["codex-7"]) }),
    );
  });

  it("does not carry a connection subset from one API key to another", async () => {
    mocks.resolveContext
      .mockResolvedValueOnce({
        ...restricted(["claude"]),
        key: { id: "key-a", name: "Key A" },
        activeConnections: { claude: ["claude-a"] },
      })
      .mockResolvedValueOnce({
        ...restricted(["claude"]),
        key: { id: "key-b", name: "Key B" },
        activeConnections: { claude: ["claude-b"] },
      });
    mocks.getModelInfo.mockResolvedValue({ provider: "claude", model: "opus" });

    await handleChat(chatRequest({ model: "cc/opus" }));
    await handleChat(chatRequest({ model: "cc/opus" }));

    const allowlists = mocks.getProviderCredentials.mock.calls.map((call) => call[3].allowedConnectionIds);
    expect(allowlists.map((allowed) => [...allowed])).toEqual([["claude-a"], ["claude-b"]]);
    expect(allowlists[1]).not.toBe(allowlists[0]);
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

  it("authorizes an all-blocked combo before considering a synthetic bypass", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.getComboModels.mockImplementation(async (model) => (
      model === "combo" ? ["cx/a", "cx/b"] : null
    ));
    mocks.handleBypassRequest.mockReturnValue({
      response: Response.json({ synthetic: true }),
    });

    const response = await handleChat(chatRequest({ model: "combo" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("no_active_combo_providers_for_api_key");
    expect(mocks.handleBypassRequest).not.toHaveBeenCalled();
    expect(mocks.handleComboChat).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("keeps an authorized direct bypass synthetic without selecting credentials", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["codex"]));
    mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });
    mocks.handleBypassRequest.mockReturnValue({
      response: Response.json({ synthetic: true }),
    });

    const response = await handleChat(chatRequest({ model: "cx/gpt-5" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ synthetic: true });
    expect(mocks.handleBypassRequest).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("keeps an authorized combo bypass synthetic without consuming combo rotation", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.getComboModels.mockImplementation(async (model) => (
      model === "combo" ? ["cc/a", "cc/b"] : null
    ));
    mocks.handleBypassRequest.mockReturnValue({
      response: Response.json({ synthetic: true }),
    });

    const response = await handleChat(chatRequest({ model: "combo" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ synthetic: true });
    expect(mocks.handleBypassRequest).toHaveBeenCalledTimes(1);
    expect(mocks.handleComboChat).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("removes an inactive capacity adapter while retaining the authorized requested provider", async () => {
    mocks.resolveContext.mockResolvedValue(restricted(["claude"]));
    mocks.augmentModelsWithCapacityAdapter.mockReturnValue(["cc/a", "cx/vision-adapter"]);

    const response = await handleChat(chatRequest({ model: "cc/a" }));

    expect(response.status).toBe(200);
    expect(mocks.handleComboChat.mock.calls.length).toBe(0);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
      "claude",
      expect.any(Set),
      "a",
      { allowedConnectionIds: null },
    );
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
    mocks.handleFusionChat.mockImplementation(async ({ body, models, handleSingleModel, judgeModel }) => {
      for (const model of models) {
        const panelResponse = await handleSingleModel(body, model, true);
        if (!panelResponse.ok) return panelResponse;
      }
      return handleSingleModel(body, judgeModel, false);
    });

    const response = await handleChat(chatRequest({ model: "fusion" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("provider_not_active_for_api_key");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderCredentials).toHaveBeenNthCalledWith(
      1,
      "claude",
      expect.any(Set),
      "a",
      { allowedConnectionIds: null },
    );
    expect(mocks.getProviderCredentials).toHaveBeenNthCalledWith(
      2,
      "claude",
      expect.any(Set),
      "b",
      { allowedConnectionIds: null },
    );
    expect(
      mocks.getProviderCredentials.mock.calls.some(([provider]) => provider === "codex"),
    ).toBe(false);
  });
});
