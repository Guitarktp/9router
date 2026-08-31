import { describe, expect, it } from "vitest";

describe("Claude weekend routing constants", () => {
  it("shares one max-age configuration object across auth, scheduler, and status", async () => {
    const [config, policy, constants] = await Promise.all([
      import("../../src/shared/constants/config.js"),
      import("../../src/shared/services/claudeWeekendRouting/policy.js"),
      import("../../src/shared/services/claudeWeekendRouting/constants.js"),
    ]);

    expect(config.CLAUDE_WEEKEND_ROUTING_CONFIG)
      .toBe(constants.CLAUDE_WEEKEND_ROUTING_CONFIG);
    expect(policy.CLAUDE_WEEKEND_MAX_OBSERVATION_AGE_MS)
      .toBe(constants.CLAUDE_WEEKEND_MAX_OBSERVATION_AGE_MS);
    expect(policy.CLAUDE_WEEKEND_MAX_OBSERVATION_AGE_MS)
      .toBe(config.CLAUDE_WEEKEND_ROUTING_CONFIG.maxObservationAgeMs);
  });
});
