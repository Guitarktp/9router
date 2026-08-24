import { describe, expect, it, vi } from "vitest";

describe("API-key routing policy", () => {
  it("keeps optional local mode unrestricted for an unknown key", async () => {
    const { resolveApiKeyRoutingContext } = await import("@/sse/services/apiKeyRouting.js");
    const context = await resolveApiKeyRoutingContext({
      apiKey: "unknown",
      requireApiKey: false,
      lookup: vi.fn().mockResolvedValue(null),
    });

    expect(context).toMatchObject({ ok: true, mode: "unrestricted" });
  });

  it("rejects an unknown key when API keys are required", async () => {
    const { resolveApiKeyRoutingContext } = await import("@/sse/services/apiKeyRouting.js");
    const context = await resolveApiKeyRoutingContext({
      apiKey: "unknown",
      requireApiKey: true,
      lookup: vi.fn().mockResolvedValue(null),
    });

    expect(context).toMatchObject({ ok: false, status: 401 });
  });

  it("maps NULL to unrestricted and an explicit list to restricted", async () => {
    const { resolveApiKeyRoutingContext } = await import("@/sse/services/apiKeyRouting.js");
    const inherited = await resolveApiKeyRoutingContext({
      apiKey: "a", requireApiKey: true,
      lookup: vi.fn().mockResolvedValue({ id: "1", name: "A", isActive: true, activeProviders: null }),
    });
    const restricted = await resolveApiKeyRoutingContext({
      apiKey: "b", requireApiKey: true,
      lookup: vi.fn().mockResolvedValue({ id: "2", name: "B", isActive: true, activeProviders: ["claude"] }),
    });

    expect(inherited.mode).toBe("unrestricted");
    expect([...restricted.activeProviders]).toEqual(["claude"]);
  });

  it("filters candidates in order without removing duplicates", async () => {
    const { filterModelCandidates } = await import("@/sse/services/apiKeyRouting.js");
    const context = { ok: true, mode: "restricted", activeProviders: new Set(["claude"]) };
    const resolveModelInfo = vi.fn(async (model) => ({
      provider: model.startsWith("cc/") ? "claude" : "codex",
      model,
    }));

    await expect(filterModelCandidates(
      ["cc/a", "cx/b", "cc/a"], context, resolveModelInfo,
    )).resolves.toEqual(["cc/a", "cc/a"]);
  });

  it("leaves unrestricted candidates unchanged without resolving them", async () => {
    const { filterModelCandidates } = await import("@/sse/services/apiKeyRouting.js");
    const candidates = ["unknown", "cc/a", "unknown"];
    const resolveModelInfo = vi.fn();

    await expect(filterModelCandidates(
      candidates,
      { ok: true, mode: "unrestricted" },
      resolveModelInfo,
    )).resolves.toBe(candidates);
    expect(resolveModelInfo).not.toHaveBeenCalled();
  });

  it("allows a route-specific error code without changing the default type", async () => {
    const { buildErrorBody } = await import("../../open-sse/utils/error.js");

    expect(buildErrorBody(403, "Provider disabled", {
      code: "provider_not_active_for_api_key",
    })).toEqual({
      error: {
        message: "Provider disabled",
        type: "permission_error",
        code: "provider_not_active_for_api_key",
      },
    });
  });

  it("allows a route-specific error type without changing the default code", async () => {
    const { buildErrorBody } = await import("../../open-sse/utils/error.js");

    expect(buildErrorBody(403, "Provider disabled", {
      type: "api_key_provider_policy_error",
    })).toEqual({
      error: {
        message: "Provider disabled",
        type: "api_key_provider_policy_error",
        code: "insufficient_quota",
      },
    });
  });

  it("forwards error type and code overrides through errorResponse", async () => {
    const { errorResponse } = await import("../../open-sse/utils/error.js");

    const response = errorResponse(403, "Provider disabled", {
      type: "api_key_provider_policy_error",
      code: "provider_not_active_for_api_key",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Provider disabled",
        type: "api_key_provider_policy_error",
        code: "provider_not_active_for_api_key",
      },
    });
  });
});
