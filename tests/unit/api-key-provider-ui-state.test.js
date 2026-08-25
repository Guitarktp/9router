import { describe, expect, it, vi } from "vitest";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("API-key provider dashboard state", () => {
  it.each([
    ["network rejection", async () => { throw new Error("offline"); }],
    [
      "non-OK response",
      async () => Response.json(
        { error: { message: "Keys unavailable" } },
        { status: 503 },
      ),
    ],
    ["invalid JSON", async () => new Response("not-json")],
  ])("returns key-context failure for %s without throwing", async (_case, fetchImpl) => {
    const { loadProviderDetailKeyContext } = await import(
      "@/app/(dashboard)/dashboard/providers/[id]/providerDetailKeyContext.js"
    );

    const result = await loadProviderDetailKeyContext(fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.keys).toEqual([]);
    expect(result.error).toEqual(expect.any(String));
  });

  it("returns API keys from a successful key-context response", async () => {
    const { loadProviderDetailKeyContext } = await import(
      "@/app/(dashboard)/dashboard/providers/[id]/providerDetailKeyContext.js"
    );
    const fetchImpl = async () => Response.json({
      keys: [{ id: "key-1", activeProviders: null, activeConnections: null }],
    });

    await expect(loadProviderDetailKeyContext(fetchImpl)).resolves.toEqual({
      ok: true,
      keys: [{ id: "key-1", activeProviders: null, activeConnections: null }],
      error: null,
    });
  });

  it("preserves a requested key view while key context is unavailable", async () => {
    const { resolveProviderDetailView } = await import(
      "@/app/(dashboard)/dashboard/providers/[id]/providerDetailKeyContext.js"
    );

    expect(
      resolveProviderDetailView("key-1", {
        ok: false,
        keys: [],
        error: "Keys unavailable",
      }),
    ).toBe("key-1");
  });

  it("falls back to Global only after a successful key catalog omits the requested key", async () => {
    const { resolveProviderDetailView } = await import(
      "@/app/(dashboard)/dashboard/providers/[id]/providerDetailKeyContext.js"
    );

    expect(
      resolveProviderDetailView("missing-key", {
        ok: true,
        keys: [{ id: "key-1" }],
        error: null,
      }),
    ).toBe("global");
  });

  it("materializes only globally active rows for inherited connection mode", async () => {
    const { materializeConnectionSelection } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );

    expect(
      materializeConnectionSelection(
        { activeConnections: null },
        "claude",
        [
          { id: "c1", isActive: true },
          { id: "c2", isActive: false },
        ],
      ),
    ).toEqual(["c1"]);
  });

  it("keeps an explicitly empty custom connection selection empty", async () => {
    const {
      getProviderConnectionMode,
      materializeConnectionSelection,
      effectiveConnectionIds,
    } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );
    const apiKey = { activeConnections: { claude: [] } };
    const connections = [{ id: "c1", isActive: true }];

    expect(getProviderConnectionMode(apiKey, "claude")).toBe("custom");
    expect(materializeConnectionSelection(apiKey, "claude", connections)).toEqual([]);
    expect(effectiveConnectionIds(apiKey, "claude", connections)).toEqual([]);
  });

  it("keeps a disabled saved selection without making it effective", async () => {
    const { materializeConnectionSelection, effectiveConnectionIds } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );
    const key = { activeConnections: { claude: ["c1"] } };
    const connections = [{ id: "c1", isActive: false }];

    expect(materializeConnectionSelection(key, "claude", connections)).toEqual(["c1"]);
    expect(effectiveConnectionIds(key, "claude", connections)).toEqual([]);
  });

  it("applies connection mode and selection transitions without enabling disabled rows", async () => {
    const {
      setProviderConnectionMode,
      nextActiveConnections,
      effectiveConnectionIds,
    } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );
    const connections = [
      { id: "c1", isActive: true },
      { id: "c2", isActive: false },
    ];

    expect(
      setProviderConnectionMode(
        { activeConnections: null },
        "claude",
        "custom",
        connections,
      ),
    ).toEqual({ claude: ["c1"] });
    expect(
      setProviderConnectionMode(
        { activeConnections: { claude: ["c1"] } },
        "claude",
        "inherit",
        connections,
      ),
    ).toBeNull();
    expect(() =>
      nextActiveConnections(
        { activeConnections: { claude: ["c1"] } },
        "claude",
        "c1",
        false,
        [{ id: "c1", isActive: true }],
      ),
    ).toThrowError(/at least one connection/i);
    expect(() =>
      nextActiveConnections(
        { activeConnections: { claude: ["c1"] } },
        "claude",
        "c2",
        true,
        connections,
      ),
    ).toThrowError(/globally disabled/i);
    expect(
      effectiveConnectionIds(
        { activeConnections: { claude: ["c1", "c2"] } },
        "claude",
        connections,
      ),
    ).toEqual(["c1"]);
  });

  it("rejects switching to custom mode when every connection is globally disabled", async () => {
    const { setProviderConnectionMode } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );

    expect(() =>
      setProviderConnectionMode(
        { activeConnections: null },
        "claude",
        "custom",
        [{ id: "c1", isActive: false }],
      ),
    ).toThrowError(/at least one connection/i);
  });

  it("saves active connection mappings and surfaces API errors", async () => {
    const { saveActiveConnections } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );
    let sentRequest;
    const okFetch = async (url, options) => {
      sentRequest = { url, options };
      return Response.json({ key: { id: "k1", activeConnections: { claude: ["c1"] } } });
    };

    await expect(
      saveActiveConnections("k1", { claude: ["c1"] }, okFetch),
    ).resolves.toMatchObject({ activeConnections: { claude: ["c1"] } });
    expect(sentRequest).toMatchObject({
      url: "/api/keys/k1",
      options: { method: "PUT", body: JSON.stringify({ activeConnections: { claude: ["c1"] } }) },
    });

    const badFetch = async () =>
      Response.json({ error: { message: "Connection save failed" } }, { status: 500 });
    await expect(
      saveActiveConnections("k1", { claude: ["c1"] }, badFetch),
    ).rejects.toThrow("Connection save failed");
  });

  it("restores the last confirmed key when the newest connection save is rejected", async () => {
    const { createActiveConnectionSaveCoordinator } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );
    const firstSave = deferred();
    const secondSave = deferred();
    const saveImpl = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const coordinator = createActiveConnectionSaveCoordinator(saveImpl);
    const confirmed = { id: "keyA", activeConnections: { claude: ["c1"] } };
    let keys = [confirmed];
    const setApiKeys = (update) => {
      keys = update(keys);
    };

    const firstOptimistic = { id: "keyA", activeConnections: { claude: ["c2"] } };
    setApiKeys(() => [firstOptimistic]);
    const olderOperation = coordinator.save({
      keyId: "keyA",
      activeConnections: { claude: ["c2"] },
      previousKey: confirmed,
      setApiKeys,
    });

    const secondOptimistic = { id: "keyA", activeConnections: { claude: ["c3"] } };
    setApiKeys(() => [secondOptimistic]);
    const newerOperation = coordinator.save({
      keyId: "keyA",
      activeConnections: { claude: ["c3"] },
      previousKey: firstOptimistic,
      setApiKeys,
    });

    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(1));
    firstSave.resolve(firstOptimistic);
    await expect(olderOperation).resolves.toMatchObject({ status: "stale" });
    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(2));
    secondSave.reject(new Error("Newest save failed"));

    await expect(newerOperation).rejects.toThrow("Newest save failed");
    expect(keys).toEqual([firstOptimistic]);
  });

  it("returns stale for an older connection success without overwriting a newer optimistic value", async () => {
    const { createActiveConnectionSaveCoordinator } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
    );
    const firstSave = deferred();
    const secondSave = deferred();
    const saveImpl = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const coordinator = createActiveConnectionSaveCoordinator(saveImpl);
    const confirmed = { id: "keyA", activeConnections: { claude: ["c1"] } };
    let keys = [confirmed];
    const setApiKeys = (update) => {
      keys = update(keys);
    };

    const firstOptimistic = { id: "keyA", activeConnections: { claude: ["c2"] } };
    setApiKeys(() => [firstOptimistic]);
    const olderOperation = coordinator.save({
      keyId: "keyA",
      activeConnections: { claude: ["c2"] },
      previousKey: confirmed,
      setApiKeys,
    });
    const secondOptimistic = { id: "keyA", activeConnections: { claude: ["c3"] } };
    setApiKeys(() => [secondOptimistic]);
    const newerOperation = coordinator.save({
      keyId: "keyA",
      activeConnections: { claude: ["c3"] },
      previousKey: firstOptimistic,
      setApiKeys,
    });

    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(1));
    firstSave.resolve(firstOptimistic);
    await expect(olderOperation).resolves.toMatchObject({ status: "stale" });
    expect(keys).toEqual([secondOptimistic]);
    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(2));
    secondSave.resolve(secondOptimistic);
    await expect(newerOperation).resolves.toMatchObject({ status: "saved" });
    expect(keys).toEqual([secondOptimistic]);
  });

  it("preserves API key context in provider detail links", async () => {
    const { buildProviderDetailHref, resolveProviderView } = await import(
      "@/app/(dashboard)/dashboard/providers/providerViewContext.js"
    );

    expect(buildProviderDetailHref("claude", "key/a")).toBe(
      "/dashboard/providers/claude?view=key%2Fa",
    );
    expect(buildProviderDetailHref("claude", "global")).toBe(
      "/dashboard/providers/claude",
    );
    expect(resolveProviderView("key/a", [{ id: "key/a" }])).toBe("key/a");
    expect(resolveProviderView("unknown", [{ id: "key/a" }])).toBe("global");
  });

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

  it("does not revert another key when an overlapping save fails", async () => {
    const { createActiveProviderSaveCoordinator } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const saves = { keyA: deferred(), keyB: deferred() };
    const saveImpl = vi.fn((keyId) => saves[keyId].promise);
    const coordinator = createActiveProviderSaveCoordinator(saveImpl);
    const originalA = { id: "keyA", activeProviders: ["claude"] };
    const originalB = { id: "keyB", activeProviders: ["codex"] };
    let keys = [originalA, originalB];
    const setApiKeys = (update) => {
      keys = update(keys);
    };

    setApiKeys((current) =>
      current.map((key) =>
        key.id === "keyA" ? { ...key, activeProviders: ["codex"] } : key,
      ),
    );
    const saveA = coordinator.save({
      keyId: "keyA",
      activeProviders: ["codex"],
      previousKey: originalA,
      setApiKeys,
    });

    setApiKeys((current) =>
      current.map((key) =>
        key.id === "keyB" ? { ...key, activeProviders: ["claude"] } : key,
      ),
    );
    const saveB = coordinator.save({
      keyId: "keyB",
      activeProviders: ["claude"],
      previousKey: originalB,
      setApiKeys,
    });

    saves.keyB.resolve({ id: "keyB", activeProviders: ["claude"] });
    await expect(saveB).resolves.toMatchObject({ status: "saved" });
    saves.keyA.reject(new Error("Key A failed"));
    await expect(saveA).rejects.toThrow("Key A failed");

    expect(keys).toEqual([
      originalA,
      { id: "keyB", activeProviders: ["claude"] },
    ]);
  });

  it("does not let an older same-key success overwrite a newer selection", async () => {
    const { createActiveProviderSaveCoordinator } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const firstSave = deferred();
    const secondSave = deferred();
    const saveImpl = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const coordinator = createActiveProviderSaveCoordinator(saveImpl);
    const original = { id: "keyA", activeProviders: ["claude", "codex"] };
    let keys = [original];
    const setApiKeys = (update) => {
      keys = update(keys);
    };

    const firstOptimistic = { id: "keyA", activeProviders: ["claude"] };
    setApiKeys(() => [firstOptimistic]);
    const olderOperation = coordinator.save({
      keyId: "keyA",
      activeProviders: ["claude"],
      previousKey: original,
      setApiKeys,
    });

    const secondOptimistic = { id: "keyA", activeProviders: ["codex"] };
    setApiKeys(() => [secondOptimistic]);
    const newerOperation = coordinator.save({
      keyId: "keyA",
      activeProviders: ["codex"],
      previousKey: firstOptimistic,
      setApiKeys,
    });

    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(1));
    firstSave.resolve({ id: "keyA", activeProviders: ["claude"] });
    await expect(olderOperation).resolves.toMatchObject({ status: "stale" });
    expect(keys).toEqual([secondOptimistic]);
    expect(saveImpl).toHaveBeenCalledTimes(2);

    secondSave.resolve({ id: "keyA", activeProviders: ["codex"] });
    await expect(newerOperation).resolves.toMatchObject({ status: "saved" });
    expect(keys).toEqual([secondOptimistic]);
  });

  it("rolls two rejected same-key saves back to the last confirmed key", async () => {
    const { createActiveProviderSaveCoordinator } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const firstSave = deferred();
    const secondSave = deferred();
    const saveImpl = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const coordinator = createActiveProviderSaveCoordinator(saveImpl);
    const confirmed = { id: "keyA", name: "Confirmed", activeProviders: ["claude", "codex"] };
    let keys = [confirmed];
    const setApiKeys = (update) => {
      keys = update(keys);
    };

    const firstOptimistic = { ...confirmed, activeProviders: ["claude"] };
    setApiKeys(() => [firstOptimistic]);
    const olderOperation = coordinator.save({
      keyId: "keyA",
      activeProviders: ["claude"],
      previousKey: confirmed,
      setApiKeys,
    });

    const secondOptimistic = { ...confirmed, activeProviders: ["codex"] };
    setApiKeys(() => [secondOptimistic]);
    const newerOperation = coordinator.save({
      keyId: "keyA",
      activeProviders: ["codex"],
      previousKey: firstOptimistic,
      setApiKeys,
    });

    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(1));
    firstSave.reject(new Error("First save failed"));
    await expect(olderOperation).resolves.toMatchObject({ status: "stale" });
    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(2));

    secondSave.reject(new Error("Second save failed"));
    await expect(newerOperation).rejects.toThrow("Second save failed");
    expect(keys).toEqual([confirmed]);
  });

  it("uses an older normalized success as rollback state for a newer failure", async () => {
    const { createActiveProviderSaveCoordinator } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const firstSave = deferred();
    const secondSave = deferred();
    const saveImpl = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);
    const coordinator = createActiveProviderSaveCoordinator(saveImpl);
    const original = { id: "keyA", name: "Original", activeProviders: ["claude", "codex"] };
    let keys = [original];
    const setApiKeys = (update) => {
      keys = update(keys);
    };

    const firstOptimistic = { ...original, activeProviders: ["claude"] };
    setApiKeys(() => [firstOptimistic]);
    const olderOperation = coordinator.save({
      keyId: "keyA",
      activeProviders: ["claude"],
      previousKey: original,
      setApiKeys,
    });

    const secondOptimistic = { ...original, activeProviders: ["codex"] };
    setApiKeys(() => [secondOptimistic]);
    const newerOperation = coordinator.save({
      keyId: "keyA",
      activeProviders: ["codex"],
      previousKey: firstOptimistic,
      setApiKeys,
    });

    const serverConfirmed = {
      id: "keyA",
      name: "Normalized by server",
      activeProviders: ["claude"],
    };
    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(1));
    firstSave.resolve(serverConfirmed);
    await expect(olderOperation).resolves.toMatchObject({ status: "stale" });
    expect(keys).toEqual([secondOptimistic]);
    await vi.waitFor(() => expect(saveImpl).toHaveBeenCalledTimes(2));

    secondSave.reject(new Error("Newer save failed"));
    await expect(newerOperation).rejects.toThrow("Newer save failed");
    expect(keys).toEqual([serverConfirmed]);
  });
});
