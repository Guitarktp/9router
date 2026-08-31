import { describe, expect, it } from "vitest";
import {
  CLAUDE_WEEKEND_REASON,
  evaluateClaudeWeeklyQuota,
  resolveClaudeWeekendRouting,
} from "../../src/shared/services/claudeWeekendRouting/policy.js";

const now = new Date("2026-08-29T05:00:00.000Z");
const observedAt = "2026-08-29T04:55:00.000Z";
const resetAt = "2026-08-30T12:00:00.000Z";
const eligibleObservation = { eligible: true, reason: "eligible", remaining: 42, resetAt, observedAt };
const freshSnapshot = (connections) => ({ enabled: true, currentlyActive: true, connections });
const evaluate = (quota, overrides = {}) => evaluateClaudeWeeklyQuota({
  quota, observedAt, now, windowEndAt: "2026-08-31T00:00:00.000Z", maxAgeMs: 900000, ...overrides,
});

describe("Claude weekly quota", () => {
  it("accepts positive remaining and derives remaining from total-used", () => {
    expect(evaluate({ remaining: 42, resetAt })).toMatchObject({ eligible: true, reason: CLAUDE_WEEKEND_REASON.ELIGIBLE, remaining: 42, resetAt, observedAt });
    expect(evaluate({ total: 100, used: 40, resetAt }).remaining).toBe(60);
  });
  it("handles exhausted, unavailable, stale, elapsed, and post-window resets", () => {
    expect(evaluate({ remaining: 0, resetAt }).reason).toBe("weekly_exhausted");
    expect(evaluate(null).reason).toBe("quota_unavailable");
    expect(evaluate({ remaining: 1, resetAt }, { maxAgeMs: 299999 }).reason).toBe("stale");
    expect(evaluate({ remaining: 1, resetAt }, { maxAgeMs: 300000 }).eligible).toBe(true);
    expect(evaluate({ remaining: 1, resetAt: "2026-08-29T05:00:00.000Z" }).reason).toBe("reset_elapsed");
    expect(evaluate({ remaining: 1, resetAt: "2026-08-31T00:00:00.001Z" }).reason).toBe("resets_after_window");
    expect(evaluate({ remaining: 1, resetAt: "2026-08-31T00:00:00.000Z" }).eligible).toBe(true);
    expect(evaluate({ remaining: 1, resetAt: "invalid" }).reason).toBe("quota_unavailable");
  });
});

describe("Claude weekend routing policy", () => {
  it("filters an eligible key intersection", () => {
    const result = resolveClaudeWeekendRouting({ providerId: "claude", baseAllowedConnectionIds: new Set(["c1", "c2"]), globalConnections: [{ id: "c1" }, { id: "c2" }], snapshot: freshSnapshot({ c2: eligibleObservation }), enabled: true, now, maxAgeMs: 900000 });
    expect([...result.allowedConnectionIds]).toEqual(["c2"]);
    expect(result.mode).toBe("filtered");
  });
  it("falls back per key when eligible intersection is empty", () => {
    const base = new Set(["c1"]);
    const result = resolveClaudeWeekendRouting({ providerId: "claude", baseAllowedConnectionIds: base, globalConnections: [{ id: "c1" }, { id: "c2" }], snapshot: freshSnapshot({ c2: eligibleObservation }), enabled: true, now, maxAgeMs: 900000 });
    expect(result.allowedConnectionIds).toBe(base);
    expect(result.mode).toBe("fallback");
  });
  it("never promotes a scheduler-known ineligible observation", () => {
    const base = new Set(["c1"]);
    const result = resolveClaudeWeekendRouting({
      providerId: "claude",
      baseAllowedConnectionIds: base,
      globalConnections: [{ id: "c1" }],
      snapshot: freshSnapshot({
        c1: { eligible: false, reason: "quota_unavailable", remaining: 42, resetAt, observedAt },
      }),
      enabled: true,
      now,
      maxAgeMs: 900000,
    });
    expect(result).toEqual({ allowedConnectionIds: base, mode: "fallback" });
  });
  it.each([
    ["disabled", { enabled: false, providerId: "claude" }],
    ["outside window", { enabled: true, providerId: "claude", now: new Date("2026-08-31T00:00:00.000Z") }],
    ["non-Claude", { enabled: true, providerId: "openai" }],
  ])("bypasses when %s", (_, overrides) => {
    const base = new Set(["c1"]);
    expect(resolveClaudeWeekendRouting({ baseAllowedConnectionIds: base, globalConnections: [], snapshot: freshSnapshot({}), maxAgeMs: 900000, ...overrides }).allowedConnectionIds).toBe(base);
  });
  it("preserves unrestricted null and omits globally inactive connections", () => {
    const result = resolveClaudeWeekendRouting({ providerId: "claude", baseAllowedConnectionIds: null, globalConnections: [{ id: "c1" }, { id: "c2" }], snapshot: freshSnapshot({ c1: eligibleObservation }), enabled: true, now, maxAgeMs: 900000 });
    expect([...result.allowedConnectionIds]).toEqual(["c1"]);
  });
  it("does not mutate caller-owned sets, arrays, or snapshots", () => {
    const base = new Set(["c1", "c2"]);
    const connections = [{ id: "c1" }, { id: "c2" }];
    const snapshot = freshSnapshot({ c1: eligibleObservation });
    resolveClaudeWeekendRouting({ providerId: "claude", baseAllowedConnectionIds: base, globalConnections: connections, snapshot, enabled: true, now, maxAgeMs: 900000 });
    expect([...base]).toEqual(["c1", "c2"]);
    expect(connections).toEqual([{ id: "c1" }, { id: "c2" }]);
    expect(snapshot).toEqual(freshSnapshot({ c1: eligibleObservation }));
  });
});
