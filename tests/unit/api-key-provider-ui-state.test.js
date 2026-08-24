import { describe, expect, it, vi } from "vitest";

describe("API-key provider dashboard state", () => {
  it("materializes all current IDs for an inherited key", async () => {
    const { materializeActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    expect(
      materializeActiveProviders(
        { activeProviders: null },
        ["claude", "codex"],
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("turns one provider off without reordering the others", async () => {
    const { nextActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    expect(
      nextActiveProviders(
        { activeProviders: null },
        ["claude", "codex"],
        "codex",
        false,
      ),
    ).toEqual(["claude"]);
  });

  it("rejects turning off the final active provider", async () => {
    const { nextActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    expect(() =>
      nextActiveProviders(
        { activeProviders: ["claude"] },
        ["claude", "codex"],
        "claude",
        false,
      ),
    ).toThrowError(/at least one provider/i);
  });

  it("recovers a stale explicit list when every stored provider was removed", async () => {
    const { materializeActiveProviders, nextActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const staleKey = { activeProviders: ["removed-provider"] };
    expect(materializeActiveProviders(staleKey, ["claude"])).toEqual([]);
    expect(
      nextActiveProviders(staleKey, ["claude"], "claude", true),
    ).toEqual(["claude"]);
  });

  it("returns normalized server state and throws on failed autosave", async () => {
    const { saveActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const okFetch = vi.fn().mockResolvedValue(
      Response.json({
        key: { id: "k1", activeProviders: ["claude"] },
      }),
    );
    await expect(saveActiveProviders("k1", ["claude"], okFetch)).resolves.toMatchObject(
      { activeProviders: ["claude"] },
    );

    const badFetch = vi.fn().mockResolvedValue(
      Response.json(
        { error: { message: "Save failed" } },
        { status: 500 },
      ),
    );
    await expect(
      saveActiveProviders("k1", ["claude"], badFetch),
    ).rejects.toThrow("Save failed");
  });
});
