import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  extractApiKey: vi.fn(),
  filterModelCandidates: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getDisabledModels: vi.fn(),
  getModelAliases: vi.fn(),
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  isProviderActive: vi.fn(),
  resolveContext: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: mocks.extractApiKey,
}));

vi.mock("@/sse/services/apiKeyRouting.js", () => ({
  filterModelCandidates: mocks.filterModelCandidates,
  isProviderActive: mocks.isProviderActive,
  resolveApiKeyRoutingContext: mocks.resolveContext,
}));

const { buildModelsList, GET } = await import("@/app/api/v1/models/route.js");

function restricted(activeProviders) {
  return {
    ok: true,
    mode: "restricted",
    key: { id: "key-1", name: "Pegasus" },
    activeProviders: new Set(activeProviders),
  };
}

function providerForModel(model) {
  if (model.startsWith("cc/")) return "claude";
  if (model.startsWith("cx/")) return "codex";
  return null;
}

describe("API key model list routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", isActive: true },
      { id: "c2", provider: "codex", isActive: true },
    ]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.extractApiKey.mockReturnValue("sk-pegasus");
    mocks.resolveContext.mockResolvedValue(restricted(["claude", "codex"]));
    mocks.isProviderActive.mockImplementation(
      (context, provider) => context.mode === "unrestricted" || context.activeProviders.has(provider),
    );
    mocks.filterModelCandidates.mockImplementation(async (models, context) => (
      context.mode === "unrestricted"
        ? models
        : models.filter((model) => context.activeProviders.has(providerForModel(model)))
    ));
  });

  it("lists only direct models owned by active providers", async () => {
    const data = await buildModelsList(["llm"], {
      routingContext: restricted(["claude"]),
      skipDynamicFetch: true,
    });

    expect(data.some((model) => model.owned_by === "cc")).toBe(true);
    expect(data.some((model) => model.owned_by === "cx")).toBe(false);
  });

  it("keeps only combos with at least one active candidate", async () => {
    mocks.getCombos.mockResolvedValue([
      { name: "usable", models: ["cc/a", "cx/b"] },
      { name: "blocked", models: ["cx/b"] },
    ]);

    const data = await buildModelsList(["llm"], {
      routingContext: restricted(["claude"]),
      skipDynamicFetch: true,
    });

    expect(data.map((model) => model.id)).toContain("usable");
    expect(data.map((model) => model.id)).not.toContain("blocked");
  });

  it("keeps the existing list for an unrestricted key context", async () => {
    mocks.resolveContext.mockResolvedValue({ ok: true, mode: "unrestricted", key: null });

    const response = await GET(new Request("http://localhost/v1/models"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.some((model) => model.owned_by === "cc")).toBe(true);
    expect(body.data.some((model) => model.owned_by === "cx")).toBe(true);
  });

  it("keeps the existing 401 envelope for a required invalid key", async () => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.resolveContext.mockResolvedValue({
      ok: false,
      status: 401,
      message: "Invalid API key",
    });

    const response = await GET(new Request("http://localhost/v1/models"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
  });
});
