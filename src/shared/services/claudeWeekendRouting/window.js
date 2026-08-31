const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const WEEKEND_DURATION_MS = 55 * 60 * 60 * 1000;

function bangkokParts(nowMs) {
  const shifted = new Date(nowMs + BANGKOK_OFFSET_MS);
  return {
    day: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    localMidnightMs: Date.UTC(
      shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
    ) - BANGKOK_OFFSET_MS,
  };
}

export function getClaudeWeekendWindow(now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid clock");

  const parts = bangkokParts(nowMs);
  const beforeMondayClose = parts.day === 1 && parts.hour < 7;
  let activeStartMs = null;
  if (parts.day === 6) activeStartMs = parts.localMidnightMs;
  if (parts.day === 0) activeStartMs = parts.localMidnightMs - 24 * 60 * 60 * 1000;
  if (beforeMondayClose) activeStartMs = parts.localMidnightMs - 48 * 60 * 60 * 1000;

  const active = activeStartMs !== null;
  const daysUntilSaturday = (6 - parts.day + 7) % 7;
  const startMs = active
    ? activeStartMs
    : parts.localMidnightMs + daysUntilSaturday * 24 * 60 * 60 * 1000;
  const endMs = startMs + WEEKEND_DURATION_MS;
  return {
    active,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    nextBoundaryAt: new Date(active ? endMs : startMs).toISOString(),
  };
}
