import { describe, expect, it } from "vitest";
import { getClaudeWeekendWindow } from "../../src/shared/services/claudeWeekendRouting/window.js";

describe("Claude weekend Bangkok window", () => {
  it.each([
    ["2026-08-28T16:59:59.000Z", false],
    ["2026-08-28T17:00:00.000Z", true],
    ["2026-08-30T23:59:59.000Z", true],
    ["2026-08-31T00:00:00.000Z", false],
  ])("evaluates %s", (iso, active) => {
    expect(getClaudeWeekendWindow(new Date(iso)).active).toBe(active);
  });

  it("closes the active weekend at Monday 07:00 Bangkok", () => {
    expect(getClaudeWeekendWindow(new Date("2026-08-29T05:00:00.000Z")).endAt)
      .toBe("2026-08-31T00:00:00.000Z");
  });

  it("accepts epoch milliseconds and rejects invalid clocks", () => {
    expect(getClaudeWeekendWindow(Date.parse("2026-08-29T05:00:00.000Z")).active).toBe(true);
    expect(() => getClaudeWeekendWindow("not-a-date")).toThrowError(new TypeError("Invalid clock"));
  });
});
