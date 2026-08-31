export const CLAUDE_WEEKEND_ROUTING_CONFIG = Object.freeze({
  timezone: "Asia/Bangkok",
  quotaKey: "weekly (7d)",
  tickIntervalMs: 10 * 60 * 1000,
  maxObservationAgeMs: 15 * 60 * 1000,
});

export const CLAUDE_WEEKEND_MAX_OBSERVATION_AGE_MS = CLAUDE_WEEKEND_ROUTING_CONFIG.maxObservationAgeMs;
