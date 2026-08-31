import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsageObservation: vi.fn(),
}));

vi.mock("@/shared/services/claudeWeekendRouting/policy.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    evaluateClaudeWeeklyQuota: vi.fn(actual.evaluateClaudeWeeklyQuota),
  };
});

const ACTIVE_NOW = new Date("2026-08-29T05:00:00.000Z");
const OUTSIDE_NOW = new Date("2026-08-31T00:00:00.000Z");
const OBSERVED_AT = "2026-08-29T04:55:00.000Z";
const RESET_AT = "2026-08-30T12:00:00.000Z";

function frozenSnapshot(overrides = {}) {
  return Object.freeze({
    generation: 0,
    enabled: true,
    currentlyActive: false,
    lastCompletedAt: null,
    windowStartAt: null,
    windowEndAt: null,
    connections: Object.freeze({}),
    ...overrides,
  });
}

function createState(snapshot = frozenSnapshot()) {
  return {
    interval: null,
    running: false,
    generation: snapshot.generation,
    snapshot,
  };
}

function usageObservation({
  remaining = 42,
  resetAt = RESET_AT,
  observedAt = OBSERVED_AT,
  source = "upstream",
  stale = false,
} = {}) {
  return {
    result: {
      plan: "Claude Code",
      quotas: {
        "weekly (7d)": {
          used: 100 - remaining,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt,
          unlimited: false,
        },
      },
    },
    observedAt,
    source,
    stale,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Claude weekend routing scheduler", () => {
  let service;
  let deps;
  let state;
  let defaultMocks;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__claudeWeekendRouting;

    const db = await import("@/lib/localDb");
    const proxy = await import("@/lib/network/connectionProxy");
    const refresh = await import("@/app/api/usage/[connectionId]/route.js");
    const usage = await import("open-sse/services/usage/claude.js");
    defaultMocks = {
      getSettings: db.getSettings,
      getProviderConnections: db.getProviderConnections,
      resolveConnectionProxyConfig: proxy.resolveConnectionProxyConfig,
      refreshAndUpdateCredentials: refresh.refreshAndUpdateCredentials,
      getClaudeUsageObservation: usage.getClaudeUsageObservation,
    };
    defaultMocks.getSettings.mockResolvedValue({ claudeWeekendRouting: { enabled: true } });
    defaultMocks.getProviderConnections.mockResolvedValue([]);
    defaultMocks.resolveConnectionProxyConfig.mockResolvedValue({});
    defaultMocks.refreshAndUpdateCredentials.mockImplementation(async (connection) => ({
      connection,
      refreshed: false,
    }));

    service = await import("../../src/shared/services/claudeWeekendRouting/service.js");
    deps = {
      getSettings: vi.fn().mockResolvedValue({ claudeWeekendRouting: { enabled: true } }),
      getProviderConnections: vi.fn().mockResolvedValue([
        { id: "c1", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-1" },
        { id: "c2", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-2" },
      ]),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      getClaudeUsageObservation: vi.fn().mockResolvedValue(usageObservation()),
      getCompletedAt: () => ACTIVE_NOW,
    };
    state = createState();
  });

  afterEach(() => {
    service?.stopClaudeWeekendRouting?.();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete global.__claudeWeekendRouting;
  });

  it("refreshes active OAuth Claude connections on an active weekend and publishes their evaluations", async () => {
    deps.refreshAndUpdateCredentials.mockImplementation(async (connection) => ({
      connection: { ...connection, accessToken: `${connection.accessToken}-refreshed` },
      refreshed: true,
    }));

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(deps.getProviderConnections).toHaveBeenCalledWith({ provider: "claude", isActive: true });
    expect(deps.refreshAndUpdateCredentials).toHaveBeenCalledTimes(2);
    expect(deps.resolveConnectionProxyConfig).toHaveBeenNthCalledWith(
      1,
      undefined,
      { safeLogging: true },
    );
    expect(deps.getClaudeUsageObservation).toHaveBeenNthCalledWith(
      1,
      "token-1-refreshed",
      {
        connectionProxyEnabled: false,
        connectionProxyUrl: "",
        connectionNoProxy: "",
        vercelRelayUrl: "",
        strictProxy: false,
        safeLogging: true,
      },
    );
    expect(state.snapshot).toMatchObject({
      generation: 1,
      enabled: true,
      currentlyActive: true,
      lastCompletedAt: ACTIVE_NOW.toISOString(),
      windowStartAt: "2026-08-28T17:00:00.000Z",
      windowEndAt: "2026-08-31T00:00:00.000Z",
      connections: {
        c1: { eligible: true, reason: "eligible", remaining: 42, resetAt: RESET_AT, observedAt: OBSERVED_AT },
        c2: { eligible: true, reason: "eligible", remaining: 42, resetAt: RESET_AT, observedAt: OBSERVED_AT },
      },
    });
  });

  it("records the actual completion instant through its deterministic clock seam", async () => {
    const completedAt = new Date("2026-08-29T05:00:02.000Z");
    deps.getCompletedAt = () => completedAt;

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(state.snapshot.lastCompletedAt).toBe("2026-08-29T05:00:02.000Z");
  });

  it("defaults a missing setting to enabled", async () => {
    deps.getSettings.mockResolvedValue({});

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(deps.getProviderConnections).toHaveBeenCalledWith({ provider: "claude", isActive: true });
    expect(state.snapshot.enabled).toBe(true);
  });

  it("publishes an empty disabled snapshot without calling provider dependencies", async () => {
    state = createState(frozenSnapshot({
      connections: Object.freeze({ c1: Object.freeze({ eligible: true, reason: "eligible" }) }),
    }));
    deps.getSettings.mockResolvedValue({ claudeWeekendRouting: { enabled: false } });

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(deps.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(deps.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(deps.getClaudeUsageObservation).not.toHaveBeenCalled();
    expect(state.snapshot).toMatchObject({ enabled: false, currentlyActive: false, connections: {} });
  });

  it("publishes an empty inactive snapshot outside the Bangkok weekend without upstream calls", async () => {
    await service.runClaudeWeekendRoutingTick(deps, state, OUTSIDE_NOW);

    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(deps.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(deps.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(deps.getClaudeUsageObservation).not.toHaveBeenCalled();
    expect(state.snapshot).toMatchObject({
      enabled: true,
      currentlyActive: false,
      windowStartAt: "2026-09-04T17:00:00.000Z",
      windowEndAt: "2026-09-07T00:00:00.000Z",
      connections: {},
    });
  });

  it("relies on the active DB filter and excludes non-OAuth rows", async () => {
    deps.getProviderConnections.mockResolvedValue([
      { id: "oauth", provider: "claude", authType: "oauth", isActive: true, accessToken: "oauth-token" },
      { id: "api-key", provider: "claude", authType: "apikey", isActive: true, apiKey: "api-secret" },
    ]);

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(deps.getProviderConnections).toHaveBeenCalledWith({ provider: "claude", isActive: true });
    expect(deps.refreshAndUpdateCredentials).toHaveBeenCalledTimes(1);
    expect(deps.refreshAndUpdateCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ id: "oauth" }),
      false,
      expect.any(Object),
    );
    expect(state.snapshot.connections).toHaveProperty("oauth");
    expect(state.snapshot.connections).not.toHaveProperty("api-key");
  });

  it("waits for each usage observation before starting the next one", async () => {
    const first = deferred();
    const second = deferred();
    deps.getClaudeUsageObservation
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const tick = service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);
    await vi.waitFor(() => expect(deps.getClaudeUsageObservation).toHaveBeenCalledTimes(1));
    expect(deps.getClaudeUsageObservation.mock.calls[0][0]).toBe("token-1");

    first.resolve(usageObservation());
    await vi.waitFor(() => expect(deps.getClaudeUsageObservation).toHaveBeenCalledTimes(2));
    expect(deps.getClaudeUsageObservation.mock.calls[1][0]).toBe("token-2");

    second.resolve(usageObservation());
    await tick;
  });

  it("marks one failed connection unavailable and continues with later connections without leaking failure details", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const completion = vi.spyOn(console, "log").mockImplementation(() => {});
    deps.getClaudeUsageObservation
      .mockRejectedValueOnce(new Error("raw-upstream-body token-1 customer-name"))
      .mockResolvedValueOnce(usageObservation());

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(deps.getClaudeUsageObservation).toHaveBeenCalledTimes(2);
    expect(state.snapshot.connections.c1).toEqual({ eligible: false, reason: "quota_unavailable" });
    expect(state.snapshot.connections.c2).toMatchObject({ eligible: true, reason: "eligible" });
    const warningText = warning.mock.calls.flat().join(" ");
    expect(warningText).toContain("c1");
    expect(warningText).not.toMatch(/raw-upstream-body|token-1|customer-name/);
    const completionText = completion.mock.calls.flat().join(" ");
    expect(completionText).toMatch(/durationMs=\d+/);
    expect(completionText).toContain("eligible=1");
    expect(completionText).toContain("weekly_exhausted=0");
    expect(completionText).toContain("resets_after_window=0");
    expect(completionText).toContain("quota_unavailable=1");
    expect(completionText).toContain("stale=0");
  });

  it.each(["settings", "connections DB"])(
    "emits one fixed completion line when the %s read fails",
    async (failurePoint) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const completion = vi.spyOn(console, "log").mockImplementation(() => {});
      const oldSnapshot = state.snapshot;
      if (failurePoint === "settings") {
        deps.getSettings.mockRejectedValue(new Error("raw settings body token-1 customer-name"));
      } else {
        deps.getProviderConnections.mockRejectedValue(
          new Error("raw DB body token-1 customer-name"),
        );
      }

      await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

      expect(state.snapshot).toBe(oldSnapshot);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls.flat().join(" ")).not.toMatch(/raw|token-1|customer-name/);
      expect(completion).toHaveBeenCalledTimes(1);
      expect(completion.mock.calls[0].join(" ")).toMatch(
        /^\[ClaudeWeekendRouting\] tick complete durationMs=\d+ eligible=0 weekly_exhausted=0 resets_after_window=0 quota_unavailable=0 reset_elapsed=0 stale=0$/,
      );
    },
  );

  it("marks observations older than fifteen minutes stale", async () => {
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-1" },
    ]);
    deps.getClaudeUsageObservation.mockResolvedValue(usageObservation({
      observedAt: "2026-08-29T04:44:59.999Z",
      source: "stale",
      stale: true,
    }));

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(state.snapshot.connections.c1).toEqual({
      eligible: false,
      reason: "stale",
      observedAt: "2026-08-29T04:44:59.999Z",
    });
  });

  it("includes reset-elapsed observations in the fixed completion counters", async () => {
    const completion = vi.spyOn(console, "log").mockImplementation(() => {});
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-1" },
    ]);
    deps.getClaudeUsageObservation.mockResolvedValue(usageObservation({
      resetAt: "2026-08-29T04:59:59.999Z",
    }));

    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);

    expect(state.snapshot.connections.c1).toMatchObject({ eligible: false, reason: "reset_elapsed" });
    expect(completion.mock.calls.flat().join(" ")).toContain("reset_elapsed=1");
  });

  it("passes the shared max age to every scheduler quota evaluation", async () => {
    await service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);
    const [policy, constants] = await Promise.all([
      import("../../src/shared/services/claudeWeekendRouting/policy.js"),
      import("../../src/shared/services/claudeWeekendRouting/constants.js"),
    ]);

    expect(policy.evaluateClaudeWeeklyQuota).toHaveBeenCalledTimes(2);
    for (const [input] of policy.evaluateClaudeWeeklyQuota.mock.calls) {
      expect(input.maxAgeMs).toBe(constants.CLAUDE_WEEKEND_MAX_OBSERVATION_AGE_MS);
    }
  });

  it("keeps the previous snapshot visible until the complete deeply frozen replacement is ready", async () => {
    const oldSnapshot = state.snapshot;
    const second = deferred();
    deps.getClaudeUsageObservation
      .mockResolvedValueOnce(usageObservation())
      .mockReturnValueOnce(second.promise);

    const tick = service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);
    await vi.waitFor(() => expect(deps.getClaudeUsageObservation).toHaveBeenCalledTimes(2));
    expect(state.snapshot).toBe(oldSnapshot);

    second.resolve(usageObservation());
    await tick;

    expect(state.snapshot).not.toBe(oldSnapshot);
    expect(Object.isFrozen(state.snapshot)).toBe(true);
    expect(Object.isFrozen(state.snapshot.connections)).toBe(true);
    expect(Object.isFrozen(state.snapshot.connections.c1)).toBe(true);
    expect(() => { state.snapshot.connections.c1.reason = "changed"; }).toThrow(TypeError);
    expect(state.snapshot.connections.c1.reason).toBe("eligible");
  });

  it("prevents overlapping ticks", async () => {
    const settings = deferred();
    deps.getSettings.mockReturnValue(settings.promise);

    const firstTick = service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);
    const overlappingTick = service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);
    await overlappingTick;

    expect(deps.getSettings).toHaveBeenCalledTimes(1);
    expect(state.running).toBe(true);
    settings.resolve({ claudeWeekendRouting: { enabled: false } });
    await firstTick;
    expect(state.running).toBe(false);
  });

  it("does not let an older generation replace newer state", async () => {
    const observation = deferred();
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-1" },
    ]);
    deps.getClaudeUsageObservation.mockReturnValue(observation.promise);

    const olderTick = service.runClaudeWeekendRoutingTick(deps, state, ACTIVE_NOW);
    await vi.waitFor(() => expect(deps.getClaudeUsageObservation).toHaveBeenCalledTimes(1));
    const newerSnapshot = frozenSnapshot({ generation: 2, enabled: false });
    state.generation = 2;
    state.snapshot = newerSnapshot;

    observation.resolve(usageObservation());
    await olderTick;

    expect(state.snapshot).toBe(newerSnapshot);
  });

  it("coalesces configuration changes during a tick into one immediate rerun and stops obsolete work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ACTIVE_NOW);
    const firstObservation = deferred();
    const rerunSettings = deferred();
    global.__claudeWeekendRouting.interval = { unref: vi.fn() };
    defaultMocks.getSettings
      .mockResolvedValueOnce({ claudeWeekendRouting: { enabled: true } })
      .mockReturnValueOnce(rerunSettings.promise);
    defaultMocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-1" },
      { id: "c2", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-2" },
    ]);
    defaultMocks.getClaudeUsageObservation
      .mockReturnValueOnce(firstObservation.promise)
      .mockResolvedValue(usageObservation());

    const activeTick = service.runClaudeWeekendRoutingTick();
    await vi.waitFor(() => expect(defaultMocks.getClaudeUsageObservation).toHaveBeenCalledTimes(1));

    service.configureClaudeWeekendRouting({ claudeWeekendRouting: { enabled: true } });
    service.configureClaudeWeekendRouting({ claudeWeekendRouting: { enabled: true } });
    firstObservation.resolve(usageObservation());
    await activeTick;

    expect(defaultMocks.getClaudeUsageObservation.mock.calls.map(([token]) => token)).toEqual(["token-1"]);
    expect(defaultMocks.getSettings).toHaveBeenCalledTimes(2);

    rerunSettings.resolve({ claudeWeekendRouting: { enabled: true } });
    await vi.waitFor(() => expect(defaultMocks.getClaudeUsageObservation).toHaveBeenCalledTimes(3));

    expect(defaultMocks.getClaudeUsageObservation.mock.calls.map(([token]) => token)).toEqual([
      "token-1",
      "token-1",
      "token-2",
    ]);
    expect(defaultMocks.getSettings).toHaveBeenCalledTimes(2);
    expect(service.getClaudeWeekendRoutingSnapshot().connections).toHaveProperty("c2");
  });

  it("starts immediately, installs one unref'd ten-minute timer, and clears only that timer", () => {
    const ownTimer = { unref: vi.fn() };
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(ownTimer);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    service.startClaudeWeekendRouting();
    service.startClaudeWeekendRouting();

    expect(defaultMocks.getSettings).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60 * 1000);
    expect(ownTimer.unref).toHaveBeenCalledTimes(1);

    service.stopClaudeWeekendRouting();
    service.stopClaudeWeekendRouting();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(ownTimer);
  });

  it("configures disabled state immediately and triggers a fresh tick when re-enabled", () => {
    global.__claudeWeekendRouting.snapshot = frozenSnapshot({
      currentlyActive: true,
      connections: Object.freeze({ c1: Object.freeze({ eligible: true, reason: "eligible" }) }),
    });
    global.__claudeWeekendRouting.interval = { unref: vi.fn() };

    service.configureClaudeWeekendRouting({ claudeWeekendRouting: { enabled: false } });

    expect(service.getClaudeWeekendRoutingSnapshot()).toMatchObject({
      enabled: false,
      currentlyActive: false,
      connections: {},
    });
    expect(defaultMocks.getSettings).not.toHaveBeenCalled();

    service.configureClaudeWeekendRouting({ claudeWeekendRouting: { enabled: true } });

    expect(service.getClaudeWeekendRoutingSnapshot().enabled).toBe(true);
    expect(defaultMocks.getSettings).toHaveBeenCalledTimes(1);
  });

  it("re-exports the snapshot held by the shared routing state", async () => {
    const { getClaudeWeekendRoutingSnapshot: getSharedSnapshot } = await import(
      "../../src/shared/services/claudeWeekendRouting/state.js"
    );
    const sharedSnapshot = frozenSnapshot({ generation: 7 });
    global.__claudeWeekendRouting.snapshot = sharedSnapshot;

    expect(getSharedSnapshot()).toBe(sharedSnapshot);
    expect(service.getClaudeWeekendRoutingSnapshot()).toBe(sharedSnapshot);
  });
});
