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
});
