import { describe, expect, it } from "vitest";
import {
  getClaudeWeekendBadge,
  getClaudeWeekendModeCopy,
  projectClaudeWeekendStatus,
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
});
