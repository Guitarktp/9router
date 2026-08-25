import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getApiKeyById: vi.fn(),
  updateApiKey: vi.fn(),
  intersectApiKeysWithCurrentCatalog: vi.fn(async (keys) => keys),
  ActiveProviderValidationError: class ActiveProviderValidationError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ActiveProviderValidationError";
      this.code = code;
      this.status = 400;
    }
  },
  normalizeActiveConnectionInput: vi.fn(),
  intersectApiKeysWithCurrentConnections: vi.fn(async (keys) => keys),
  ActiveConnectionValidationError: class ActiveConnectionValidationError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ActiveConnectionValidationError";
      this.code = code;
      this.status = 400;
    }
  },
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
  getApiKeyById: mocks.getApiKeyById,
  updateApiKey: mocks.updateApiKey,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), { status: init.status || 200 });
    },
  },
}));

const deps = {
  getProviderIds: async () => ["claude", "codex"],
  getConnections: async () => [
    { id: "claude-1", provider: "claude", isActive: true },
    { id: "claude-2", provider: "claude", isActive: false },
    { id: "codex-1", provider: "codex", isActive: true },
  ],
};

describe("API-key connection policy validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/apiKeyConnectionPolicy.js");
  });

  it("accepts a non-empty mapping", async () => {
    const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
    await expect(normalizeActiveConnectionInput(
      { claude: ["claude-1"] }, null, deps,
    )).resolves.toEqual({ claude: ["claude-1"] });
  });

  it("rejects a newly selected globally inactive connection", async () => {
    const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
    await expect(normalizeActiveConnectionInput(
      { claude: ["claude-2"] }, null, deps,
    )).rejects.toMatchObject({ code: "connection_globally_inactive" });
  });

  it("retains a prior selection after global disable", async () => {
    const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
    await expect(normalizeActiveConnectionInput(
      { claude: ["claude-2"] }, { claude: ["claude-2"] }, deps,
    )).resolves.toEqual({ claude: ["claude-2"] });
  });

  it.each([
    [{ claude: [] }, "at_least_one_connection_required"],
    [{ claude: ["claude-1", "claude-1"] }, "invalid_active_connections"],
    [{ missing: ["claude-1"] }, "invalid_active_connections"],
    [{ claude: ["codex-1"] }, "invalid_active_connections"],
  ])("rejects invalid policy %j", async (value, code) => {
    const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
    await expect(normalizeActiveConnectionInput(value, null, deps))
      .rejects.toMatchObject({ code });
  });

  it("filters stale IDs without restoring inheritance", async () => {
    const { intersectApiKeysWithCurrentConnections } = await import("@/lib/apiKeyConnectionPolicy.js");
    const [key] = await intersectApiKeysWithCurrentConnections([
      { id: "key-1", activeConnections: { claude: ["deleted"] } },
    ], deps);
    expect(key.activeConnections).toEqual({ claude: [] });
  });

  it("canonicalizes provider aliases", async () => {
    const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
    await expect(normalizeActiveConnectionInput(
      { cc: ["claude-1"] }, null, deps,
    )).resolves.toEqual({ claude: ["claude-1"] });
  });

  it("treats an empty mapping as inherited connections", async () => {
    const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
    await expect(normalizeActiveConnectionInput({}, null, deps)).resolves.toBeNull();
  });
});

describe("API-key connection policy routes", () => {
  async function loadListGet() {
    vi.doMock("@/lib/apiKeyProviderCatalog.js", () => ({
      intersectApiKeysWithCurrentCatalog: mocks.intersectApiKeysWithCurrentCatalog,
      ActiveProviderValidationError: mocks.ActiveProviderValidationError,
      normalizeActiveProviderInput: vi.fn(),
    }));
    vi.doMock("@/lib/apiKeyConnectionPolicy.js", () => ({
      intersectApiKeysWithCurrentConnections: mocks.intersectApiKeysWithCurrentConnections,
    }));
    const { GET } = await import("@/app/api/keys/route.js");
    return GET;
  }

  async function loadSingleRoutes() {
    vi.doMock("@/lib/apiKeyProviderCatalog.js", () => ({
      intersectApiKeysWithCurrentCatalog: mocks.intersectApiKeysWithCurrentCatalog,
      ActiveProviderValidationError: mocks.ActiveProviderValidationError,
      normalizeActiveProviderInput: vi.fn(),
    }));
    vi.doMock("@/lib/apiKeyConnectionPolicy.js", () => ({
      normalizeActiveConnectionInput: mocks.normalizeActiveConnectionInput,
      intersectApiKeysWithCurrentConnections: mocks.intersectApiKeysWithCurrentConnections,
      ActiveConnectionValidationError: mocks.ActiveConnectionValidationError,
    }));
    return import("@/app/api/keys/[id]/route.js");
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getApiKeyById.mockResolvedValue({
      id: "key-1",
      isActive: true,
      activeConnections: { claude: ["claude-2"] },
    });
    mocks.updateApiKey.mockImplementation(async (id, updateData) => ({ id, ...updateData }));
  });

  it("filters list reads by the current provider catalog before connections", async () => {
    mocks.getApiKeys.mockResolvedValue([{ id: "key-1", activeConnections: { claude: ["claude-1"] } }]);
    mocks.intersectApiKeysWithCurrentCatalog.mockResolvedValue([{ id: "key-1", catalogFiltered: true }]);
    mocks.intersectApiKeysWithCurrentConnections.mockResolvedValue([{ id: "key-1", catalogFiltered: true, connectionsFiltered: true }]);
    const GET = await loadListGet();

    const response = await GET();

    expect(mocks.intersectApiKeysWithCurrentConnections).toHaveBeenCalledWith([
      { id: "key-1", catalogFiltered: true },
    ]);
    await expect(response.json()).resolves.toEqual({
      keys: [{ id: "key-1", catalogFiltered: true, connectionsFiltered: true }],
    });
  });

  it("filters a single-key read by the current connections", async () => {
    mocks.intersectApiKeysWithCurrentCatalog.mockResolvedValue([{ id: "key-1", catalogFiltered: true }]);
    mocks.intersectApiKeysWithCurrentConnections.mockResolvedValue([{ id: "key-1", catalogFiltered: true, connectionsFiltered: true }]);
    const { GET } = await loadSingleRoutes();

    const response = await GET(new Request("http://localhost/api/keys/key-1"), {
      params: Promise.resolve({ id: "key-1" }),
    });

    await expect(response.json()).resolves.toEqual({
      key: { id: "key-1", catalogFiltered: true, connectionsFiltered: true },
    });
  });

  it("passes normalized connections and prior selections to the repository", async () => {
    mocks.normalizeActiveConnectionInput.mockResolvedValue({ claude: ["claude-1"] });
    const { PUT } = await loadSingleRoutes();
    const request = new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeConnections: { claude: ["claude-1"] } }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "key-1" }) });

    expect(mocks.normalizeActiveConnectionInput).toHaveBeenCalledWith(
      { claude: ["claude-1"] },
      { claude: ["claude-2"] },
    );
    expect(mocks.updateApiKey).toHaveBeenCalledWith("key-1", {
      activeConnections: { claude: ["claude-1"] },
    });
    expect(response.status).toBe(200);
  });

  it("returns connection validation errors without updating the key", async () => {
    mocks.normalizeActiveConnectionInput.mockRejectedValue(
      new mocks.ActiveConnectionValidationError("connection_globally_inactive", "Connection is inactive"),
    );
    const { PUT } = await loadSingleRoutes();
    const request = new Request("http://localhost/api/keys/key-1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeConnections: { claude: ["claude-2"] } }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "key-1" }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "connection_globally_inactive", message: "Connection is inactive" },
    });
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
  });
});
