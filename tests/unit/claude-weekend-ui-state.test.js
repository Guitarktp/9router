import { describe, expect, it } from "vitest";
import {
  createClaudeWeekendStatusLifecycle,
  createClaudeWeekendStatusRequestContext,
  createUnavailableClaudeWeekendStatus,
  getClaudeWeekendBadge,
  getClaudeWeekendModeCopy,
  projectClaudeWeekendStatus,
  selectClaudeWeekendStatus,
  settleClaudeWeekendStatus,
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

  it("rejects late same-context A settlements and accepts the current B success", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const context = createClaudeWeekendStatusRequestContext("claude", "key-a");
    const requestA = lifecycle.begin(context);
    const requestB = lifecycle.begin(context);

    expect(settleClaudeWeekendStatus(lifecycle, requestA, { mode: "filtered", connections: {} })).toBeNull();
    expect(settleClaudeWeekendStatus(
      lifecycle,
      requestA,
      createUnavailableClaudeWeekendStatus(),
    )).toBeNull();
    expect(settleClaudeWeekendStatus(lifecycle, requestB, { mode: "filtered", connections: {} })).toEqual({
      contextKey: context,
      requestId: requestB.id,
      mode: "filtered",
      connections: {},
    });
  });

  it("settles the current B failure as quota unavailable with B's real request ID", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const context = createClaudeWeekendStatusRequestContext("claude", "key-a");
    lifecycle.begin(context);
    const requestB = lifecycle.begin(context);
    const unavailable = settleClaudeWeekendStatus(
      lifecycle,
      requestB,
      createUnavailableClaudeWeekendStatus(),
    );

    expect(unavailable).toEqual({
      contextKey: context,
      requestId: requestB.id,
      unavailable: true,
      connections: {},
    });
    expect(getClaudeWeekendModeCopy(unavailable)).toBe("Quota unavailable");
  });

  it("invalidates a request during cleanup, including visibility polling cleanup", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const context = createClaudeWeekendStatusRequestContext("claude", "key-a");
    const request = lifecycle.begin(context);

    lifecycle.invalidate(request);

    expect(settleClaudeWeekendStatus(lifecycle, request, { connections: {} })).toBeNull();
  });

  it("does not reuse an older status when Claude is revisited with the same key", () => {
    const lifecycle = createClaudeWeekendStatusLifecycle();
    const context = createClaudeWeekendStatusRequestContext("claude", "key-a");
    const firstRequest = lifecycle.begin(context);
    const oldStatus = { contextKey: context, requestId: firstRequest.id, connections: {} };

    lifecycle.invalidate(firstRequest);
    const currentRequest = lifecycle.begin(context);

    expect(selectClaudeWeekendStatus(
      oldStatus,
      context,
      oldStatus.requestId === currentRequest.id,
    )).toBeNull();
  });
});
