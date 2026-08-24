import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderNodes: vi.fn(),
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  getApiKeyById: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  normalizeActiveProviderInput: vi.fn(),
  intersectApiKeysWithCurrentCatalog: vi.fn(async (keys) => keys),
  ActiveProviderValidationError: class ActiveProviderValidationError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ActiveProviderValidationError";
      this.code = code;
      this.status = 400;
    }
  },
}));

vi.mock("@/lib/localDb", () => ({
  getProviderNodes: mocks.getProviderNodes,
  getApiKeys: mocks.getApiKeys,
  createApiKey: mocks.createApiKey,
  getApiKeyById: mocks.getApiKeyById,
  updateApiKey: mocks.updateApiKey,
  deleteApiKey: mocks.deleteApiKey,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), { status: init.status || 200 });
    },
  },
}));

describe("API-key provider catalog", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/apiKeyProviderCatalog.js");
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-team", type: "openai-compatible", prefix: "team" },
      { id: "anthropic-compatible-research", type: "anthropic-compatible", prefix: "research" },
      { id: "custom-embedding-x", type: "custom-embedding", prefix: "embed" },
    ]);
  });

  it("contains visible built-in LLM providers and compatible nodes only", async () => {
    const { getRoutableProviderIds } = await import("@/lib/apiKeyProviderCatalog.js");
    const ids = await getRoutableProviderIds();

    expect(ids).toContain("claude");
    expect(ids).toContain("openai-compatible-team");
    expect(ids).toContain("anthropic-compatible-research");
    expect(ids).not.toContain("custom-embedding-x");
  });

  it("excludes web-cookie providers that are not visible on the Providers page", async () => {
    const { getRoutableProviderIds, normalizeActiveProviderInput } = await import("@/lib/apiKeyProviderCatalog.js");

    await expect(normalizeActiveProviderInput(["grok-web"])).rejects.toMatchObject({
      code: "invalid_active_providers",
    });
    await expect(normalizeActiveProviderInput(["perplexity-web"])).rejects.toMatchObject({
      code: "invalid_active_providers",
    });
    expect(await getRoutableProviderIds()).not.toEqual(
      expect.arrayContaining(["grok-web", "perplexity-web"]),
    );
  });

  it("canonicalizes aliases and rejects duplicates after canonicalization", async () => {
    const { normalizeActiveProviderInput } = await import("@/lib/apiKeyProviderCatalog.js");

    await expect(normalizeActiveProviderInput(["cc", "claude"])).rejects.toMatchObject({
      code: "invalid_active_providers",
    });
  });

  it("canonicalizes registry secondary aliases in request order", async () => {
    const { normalizeActiveProviderInput } = await import("@/lib/apiKeyProviderCatalog.js");

    await expect(normalizeActiveProviderInput([
      "openai-compatible-team",
      "kmc",
      "grok-build",
      "anthropic-compatible-research",
    ])).resolves.toEqual([
      "openai-compatible-team",
      "kimi",
      "grok-cli",
      "anthropic-compatible-research",
    ]);
  });

  it("rejects duplicates collapsed through a registry secondary alias", async () => {
    const { normalizeActiveProviderInput } = await import("@/lib/apiKeyProviderCatalog.js");

    await expect(normalizeActiveProviderInput(["kimi", "kmc"]))
      .rejects.toMatchObject({
        code: "invalid_active_providers",
        message: "Duplicate provider: kimi",
      });
  });

  it("rejects empty and unknown provider lists", async () => {
    const { normalizeActiveProviderInput } = await import("@/lib/apiKeyProviderCatalog.js");

    await expect(normalizeActiveProviderInput([])).rejects.toMatchObject({
      code: "at_least_one_provider_required",
    });
    await expect(normalizeActiveProviderInput(["missing-provider"])).rejects.toMatchObject({
      code: "invalid_active_providers",
    });
  });
});

describe("API-key routes", () => {
  async function loadPut() {
    vi.doMock("@/lib/apiKeyProviderCatalog.js", () => ({
      normalizeActiveProviderInput: mocks.normalizeActiveProviderInput,
      intersectApiKeysWithCurrentCatalog: mocks.intersectApiKeysWithCurrentCatalog,
      ActiveProviderValidationError: mocks.ActiveProviderValidationError,
    }));
    const { PUT } = await import("@/app/api/keys/[id]/route.js");
    return PUT;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/apiKeyProviderCatalog.js");
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-team", type: "openai-compatible", prefix: "team" },
    ]);
    mocks.getApiKeyById.mockResolvedValue({ id: "key-1", isActive: true });
    mocks.updateApiKey.mockImplementation(async (id, updateData) => ({ id, ...updateData }));
  });

  it("intersects API-key list reads with the current catalog", async () => {
    mocks.getApiKeys.mockResolvedValue([
      { id: "inherited", activeProviders: null },
      { id: "stale", activeProviders: ["removed-provider"] },
      {
        id: "mixed",
        activeProviders: ["claude", "removed-provider", "openai-compatible-team"],
      },
    ]);
    const { GET } = await import("@/app/api/keys/route.js");

    const response = await GET();
    const body = await response.json();

    expect(body.keys.map((key) => key.activeProviders)).toEqual([
      null,
      [],
      ["claude", "openai-compatible-team"],
    ]);
  });

  it("keeps a stale customized single-key read restricted with an empty list", async () => {
    mocks.getApiKeyById.mockResolvedValue({
      id: "stale",
      isActive: true,
      activeProviders: ["removed-provider"],
    });
    const { GET } = await import("@/app/api/keys/[id]/route.js");

    const response = await GET(new Request("http://localhost/api/keys/stale"), {
      params: Promise.resolve({ id: "stale" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      key: { id: "stale", activeProviders: [] },
    });
  });

  it("passes canonical active providers to the repository", async () => {
    mocks.normalizeActiveProviderInput.mockResolvedValue(["claude", "codex"]);
    const PUT = await loadPut();
    const req = new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeProviders: ["cc", "codex"] }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: "key-1" }) });

    expect(mocks.updateApiKey).toHaveBeenCalledWith("key-1", {
      activeProviders: ["claude", "codex"],
    });
    expect(res.status).toBe(200);
  });

  it("returns the validation error code without updating the key", async () => {
    mocks.normalizeActiveProviderInput.mockRejectedValue(
      new mocks.ActiveProviderValidationError("invalid_active_providers", "Unknown provider"),
    );
    const PUT = await loadPut();
    const req = new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeProviders: ["missing-provider"] }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: "key-1" }) });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: "invalid_active_providers", message: "Unknown provider" },
    });
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
  });

  it("keeps isActive-only updates independent of provider validation", async () => {
    const PUT = await loadPut();
    const req = new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });

    const res = await PUT(req, { params: Promise.resolve({ id: "key-1" }) });

    expect(mocks.normalizeActiveProviderInput).not.toHaveBeenCalled();
    expect(mocks.updateApiKey).toHaveBeenCalledWith("key-1", { isActive: false });
    expect(res.status).toBe(200);
  });
});
