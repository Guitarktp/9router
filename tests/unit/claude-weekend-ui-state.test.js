import { describe, expect, it } from "vitest";
import {
  createClaudeWeekendStatusLifecycle,
  createClaudeWeekendStatusRequestContext,
  createUnavailableClaudeWeekendStatus,
  getClaudeWeekendBadge,
  getClaudeWeekendModeCopy,
  projectClaudeWeekendStatus,
  selectClaudeWeekendStatus,
} from "@/app/(dashboard)/dashboard/providers/[id]/claudeWeekendStatusUi.js";

describe("Claude weekend routing UI state", () => {
  it.each([
    ["eligible", "Weekend eligible", "success"],
    ["weekly_exhausted", "Weekly exhausted", "warning"],
    ["resets_after_window", "Resets after window", "muted"],
    ["quota_unavailable", "Quota unavailable", "danger"],
  ])("maps %s to an operational badge", (reason, label, tone) => {
    expect(getClaudeWeekendBadge({ reason })).toEqual({ label, tone });
  });

  it("maps an inactive routing status to the inactive copy", () => {
    expect(getClaudeWeekendBadge({ reason: "inactive" })).toEqual({
      label: "Weekend mode inactive",
      tone: "muted",
    });
  });

  it.each([
    ["filtered", "Weekend filter active for this API key"],
    ["fallback", "No eligible connection for this API key — using original configuration"],
    ["inactive", "Weekend mode inactive"],
  ])("uses exact per-key %s mode copy", (mode, copy) => {
    expect(getClaudeWeekendModeCopy({ mode })).toBe(copy);
  });

  it("keeps connection management visible with a quota-unavailable status copy", () => {
    expect(getClaudeWeekendModeCopy({ unavailable: true })).toBe("Quota unavailable");
  });

  it("projects only safe connection status fields", () => {
    const result = projectClaudeWeekendStatus({
      enabled: true,
      currentlyActive: true,
      mode: "filtered",
      connections: {
        connection_1: {
          eligible: true,
          reason: "eligible",
          remaining: 32,
          resetAt: "2026-09-01T00:00:00.000Z",
          observedAt: "2026-08-31T00:00:00.000Z",
          accessToken: "secret-access-token",
          refreshToken: "secret-refresh-token",
          apiKey: "secret-api-key",
          clientSecret: "secret-client-secret",
        },
      },
      accessToken: "top-level-token",
    });

    expect(result).toEqual({
      enabled: true,
      currentlyActive: true,
      mode: "filtered",
      connections: {
        connection_1: {
          eligible: true,
          reason: "eligible",
          remaining: 32,
          resetAt: "2026-09-01T00:00:00.000Z",
          observedAt: "2026-08-31T00:00:00.000Z",
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|apiKey|clientSecret|secret-access-token/i);
  });

  it("hides an A status synchronously when the requested Claude key changes to B", () => {
    const statusA = {
      contextKey: createClaudeWeekendStatusRequestContext("claude", "key-a"),
      mode: "filtered",
      connections: {},
    };
    const contextB = createClaudeWeekendStatusRequestContext("claude", "key-b");

    expect(selectClaudeWeekendStatus(statusA, contextB)).toBeNull();
  });

  it("does not reuse a Claude status after navigating to a non-Claude provider", () => {
    const statusA = {
      contextKey: createClaudeWeekendStatusRequestContext("claude", "key-a"),
      connections: {},
    };

    expect(selectClaudeWeekendStatus(statusA, createClaudeWeekendStatusRequestContext("codex", "key-a"))).toBeNull();
  });

  it("ignores late A successes and failures after B becomes the active request", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const contextA = createClaudeWeekendStatusRequestContext("claude", "key-a");
    const contextB = createClaudeWeekendStatusRequestContext("claude", "key-b");
    const requestA = lifecycle.begin(contextA);
    const requestB = lifecycle.begin(contextB);

    expect(lifecycle.canApply(requestA, contextB)).toBe(false);
    expect(lifecycle.canApply(requestB, contextB)).toBe(true);
  });

  it("allows the current failure to become the quota-unavailable status", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const context = createClaudeWeekendStatusRequestContext("claude", "key-a");
    const request = lifecycle.begin(context);
    const unavailable = createUnavailableClaudeWeekendStatus(context);

    expect(lifecycle.canApply(request, context)).toBe(true);
    expect(selectClaudeWeekendStatus(unavailable, context)).toEqual(unavailable);
    expect(getClaudeWeekendModeCopy(unavailable)).toBe("Quota unavailable");
  });

  it("invalidates a request during cleanup, including visibility polling cleanup", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const context = createClaudeWeekendStatusRequestContext("claude", "key-a");
    const request = lifecycle.begin(context);

    lifecycle.invalidate(request);

    expect(lifecycle.canApply(request, context)).toBe(false);
  });

  it("does not reuse an older status when Claude is revisited with the same key", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const context = createClaudeWeekendStatusRequestContext("claude", "key-a");
    const firstRequest = lifecycle.begin(context);
    const oldStatus = { contextKey: context, requestId: firstRequest.id, connections: {} };

    lifecycle.invalidate(firstRequest);
    lifecycle.begin(context);

    expect(selectClaudeWeekendStatus(oldStatus, context, lifecycle.isStatusCurrent(oldStatus))).toBeNull();
  });
});
