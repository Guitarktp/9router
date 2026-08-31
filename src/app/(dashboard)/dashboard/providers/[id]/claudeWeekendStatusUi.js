const CONNECTION_REASONS = new Set([
  "eligible",
  "weekly_exhausted",
  "reset_elapsed",
  "resets_after_window",
  "quota_unavailable",
  "stale",
]);

const KEY_VIEW_MODES = new Set(["filtered", "fallback", "inactive"]);

function projectConnectionStatus(status) {
  const result = {
    eligible: status?.eligible === true,
    reason: CONNECTION_REASONS.has(status?.reason) ? status.reason : "quota_unavailable",
  };
  if (Number.isFinite(Number(status?.remaining))) result.remaining = Number(status.remaining);
  if (typeof status?.resetAt === "string") result.resetAt = status.resetAt;
  if (typeof status?.observedAt === "string") result.observedAt = status.observedAt;
  return result;
}

export function projectClaudeWeekendStatus(status) {
  const connections = Object.fromEntries(
    Object.entries(status?.connections || {}).map(([id, connection]) => [
      id,
      projectConnectionStatus(connection),
    ]),
  );
  const result = {
    enabled: status?.enabled === true,
    currentlyActive: status?.currentlyActive === true,
    connections,
  };
  if (KEY_VIEW_MODES.has(status?.mode)) result.mode = status.mode;
  return result;
}

export function getClaudeWeekendBadge(status) {
  switch (status?.reason) {
    case "eligible":
      return { label: "Weekend eligible", tone: "success" };
    case "weekly_exhausted":
      return { label: "Weekly exhausted", tone: "warning" };
    case "resets_after_window":
    case "reset_elapsed":
      return { label: "Resets after window", tone: "muted" };
    case "inactive":
      return { label: "Weekend mode inactive", tone: "muted" };
    case "quota_unavailable":
    case "stale":
    default:
      return { label: "Quota unavailable", tone: "danger" };
  }
}

export function getClaudeWeekendModeCopy(status) {
  if (status?.unavailable === true) return "Quota unavailable";
  switch (status?.mode) {
    case "filtered":
      return "Weekend filter active for this API key";
    case "fallback":
      return "No eligible connection for this API key — using original configuration";
    case "inactive":
    default:
      return "Weekend mode inactive";
  }
}
