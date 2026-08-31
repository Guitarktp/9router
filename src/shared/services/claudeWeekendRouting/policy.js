import { getClaudeWeekendWindow } from "./window.js";
import { CLAUDE_WEEKEND_MAX_OBSERVATION_AGE_MS } from "./constants.js";

export { CLAUDE_WEEKEND_MAX_OBSERVATION_AGE_MS };

export const CLAUDE_WEEKEND_REASON = Object.freeze({
  ELIGIBLE: "eligible",
  WEEKLY_EXHAUSTED: "weekly_exhausted",
  RESET_ELAPSED: "reset_elapsed",
  RESETS_AFTER_WINDOW: "resets_after_window",
  QUOTA_UNAVAILABLE: "quota_unavailable",
  STALE: "stale",
});

export function evaluateClaudeWeeklyQuota({ quota, observedAt, now, windowEndAt, maxAgeMs }) {
  const nowMs = new Date(now).getTime();
  const observedMs = new Date(observedAt).getTime();
  if (!quota || !Number.isFinite(observedMs)) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.QUOTA_UNAVAILABLE };
  }
  if (nowMs - observedMs > maxAgeMs) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.STALE, observedAt };
  }
  const remaining = Number.isFinite(Number(quota.remaining))
    ? Number(quota.remaining)
    : Number(quota.total) - Number(quota.used);
  if (!Number.isFinite(remaining)) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.QUOTA_UNAVAILABLE, observedAt };
  }
  if (remaining <= 0) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.WEEKLY_EXHAUSTED, remaining, observedAt };
  }
  const resetMs = new Date(quota.resetAt).getTime();
  if (!Number.isFinite(resetMs)) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.QUOTA_UNAVAILABLE, remaining, observedAt };
  }
  if (resetMs <= nowMs) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.RESET_ELAPSED, remaining, resetAt: quota.resetAt, observedAt };
  }
  if (resetMs > new Date(windowEndAt).getTime()) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.RESETS_AFTER_WINDOW, remaining, resetAt: quota.resetAt, observedAt };
  }
  return { eligible: true, reason: CLAUDE_WEEKEND_REASON.ELIGIBLE, remaining, resetAt: quota.resetAt, observedAt };
}

export function resolveClaudeWeekendRouting(input) {
  const original = input.baseAllowedConnectionIds;
  const window = getClaudeWeekendWindow(input.now);
  if (input.providerId !== "claude" || input.enabled !== true || !window.active) {
    return { allowedConnectionIds: original, mode: "inactive" };
  }

  const globalIds = new Set(input.globalConnections.map((connection) => connection.id));
  const baseIds = original === null
    ? globalIds
    : new Set([...original].filter((id) => globalIds.has(id)));
  const filtered = new Set([...baseIds].filter((id) => {
    const observation = input.snapshot?.connections?.[id];
    return evaluateClaudeWeeklyQuota({
      quota: observation,
      observedAt: observation?.observedAt,
      now: input.now,
      windowEndAt: window.endAt,
      maxAgeMs: input.maxAgeMs,
    }).eligible;
  }));
  return filtered.size > 0
    ? { allowedConnectionIds: filtered, mode: "filtered" }
    : { allowedConnectionIds: original, mode: "fallback" };
}
