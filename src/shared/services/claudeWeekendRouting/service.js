import "open-sse/index.js";

import { getSettings, getProviderConnections } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { CLAUDE_WEEKEND_ROUTING_CONFIG } from "@/shared/constants/config";
import { getClaudeUsageObservation } from "open-sse/services/usage/claude.js";
import { CLAUDE_WEEKEND_REASON, evaluateClaudeWeeklyQuota } from "./policy.js";
import { getClaudeWeekendWindow } from "./window.js";

const C = CLAUDE_WEEKEND_ROUTING_CONFIG;

const g = (global.__claudeWeekendRouting ??= {
  interval: null,
  running: false,
  rerunRequested: false,
  generation: 0,
  snapshot: Object.freeze({
    generation: 0,
    enabled: true,
    currentlyActive: false,
    lastCompletedAt: null,
    windowStartAt: null,
    windowEndAt: null,
    connections: Object.freeze({}),
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function buildProxyOptions(config) {
  return {
    connectionProxyEnabled: config.connectionProxyEnabled === true,
    connectionProxyUrl: config.connectionProxyUrl || "",
    connectionNoProxy: config.connectionNoProxy || "",
    vercelRelayUrl: config.vercelRelayUrl || "",
    strictProxy: false,
    safeLogging: true,
  };
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    refreshAndUpdateCredentials,
    resolveConnectionProxyConfig,
    getClaudeUsageObservation,
  };
}

function createSnapshot({ generation, enabled, window, completedAt, connections }) {
  return deepFreeze({
    generation,
    enabled,
    currentlyActive: enabled && window.active,
    lastCompletedAt: completedAt,
    windowStartAt: window.startAt,
    windowEndAt: window.endAt,
    connections,
  });
}

function publishIfCurrent(state, generation, snapshot) {
  if (state.generation !== generation) return false;
  state.snapshot = snapshot;
  return true;
}

function logCompletion(startedAt, connections) {
  const counts = {
    eligible: 0,
    weekly_exhausted: 0,
    resets_after_window: 0,
    quota_unavailable: 0,
    stale: 0,
  };
  for (const result of Object.values(connections)) {
    if (Object.hasOwn(counts, result.reason)) counts[result.reason] += 1;
  }
  console.log(
    `[ClaudeWeekendRouting] tick complete durationMs=${Math.max(0, Date.now() - startedAt)}`
    + ` eligible=${counts.eligible}`
    + ` weekly_exhausted=${counts.weekly_exhausted}`
    + ` resets_after_window=${counts.resets_after_window}`
    + ` quota_unavailable=${counts.quota_unavailable}`
    + ` stale=${counts.stale}`,
  );
}

export async function runClaudeWeekendRoutingTick(
  deps = createDefaultDeps(),
  state = g,
  now = new Date(),
) {
  if (state.running) return;
  state.running = true;
  const startedAt = Date.now();
  const generation = ++state.generation;
  const connections = {};

  try {
    const currentTime = now instanceof Date ? now : new Date(now);
    const settings = await deps.getSettings();
    if (state.generation !== generation) return;
    const enabled = settings?.claudeWeekendRouting?.enabled !== false;
    const window = getClaudeWeekendWindow(currentTime);

    if (enabled && window.active) {
      const storedConnections = await deps.getProviderConnections({ provider: "claude", isActive: true });
      if (state.generation !== generation) return;
      const targets = storedConnections.filter((connection) => connection.authType === "oauth");

      for (const storedConnection of targets) {
        if (state.generation !== generation) break;
        try {
          const proxyConfig = await deps.resolveConnectionProxyConfig(
            storedConnection.providerSpecificData,
            { safeLogging: true },
          );
          if (state.generation !== generation) break;
          const proxyOptions = buildProxyOptions(proxyConfig);
          const refresh = await deps.refreshAndUpdateCredentials(storedConnection, false, proxyOptions);
          if (state.generation !== generation) break;
          const connection = refresh.connection;
          const observation = await deps.getClaudeUsageObservation(connection.accessToken, proxyOptions);
          if (state.generation !== generation) break;
          connections[storedConnection.id] = evaluateClaudeWeeklyQuota({
            quota: observation?.result?.quotas?.[C.quotaKey],
            observedAt: observation?.observedAt,
            now: currentTime,
            windowEndAt: window.endAt,
            maxAgeMs: C.maxObservationAgeMs,
          });
        } catch {
          if (state.generation !== generation) break;
          connections[storedConnection.id] = {
            eligible: false,
            reason: CLAUDE_WEEKEND_REASON.QUOTA_UNAVAILABLE,
          };
          console.warn(
            `[ClaudeWeekendRouting] connection ${storedConnection.id} failed reason=quota_unavailable`,
          );
        }
      }
    }

    const snapshot = createSnapshot({
      generation,
      enabled,
      window,
      completedAt: currentTime.toISOString(),
      connections,
    });
    publishIfCurrent(state, generation, snapshot);
  } catch {
    console.warn("[ClaudeWeekendRouting] tick failed reason=quota_unavailable");
  } finally {
    state.running = false;
    logCompletion(startedAt, connections);
    if (state === g && state.rerunRequested) {
      state.rerunRequested = false;
      runClaudeWeekendRoutingTick().catch(() => {});
    }
  }
}

export function getClaudeWeekendRoutingSnapshot() {
  return g.snapshot;
}

export function startClaudeWeekendRouting() {
  if (g.interval) return;
  runClaudeWeekendRoutingTick().catch(() => {});
  g.interval = setInterval(() => {
    runClaudeWeekendRoutingTick().catch(() => {});
  }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopClaudeWeekendRouting() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
}

export function configureClaudeWeekendRouting(settings) {
  const enabled = settings?.claudeWeekendRouting?.enabled !== false;
  const generation = ++g.generation;
  g.snapshot = deepFreeze({
    ...g.snapshot,
    generation,
    enabled,
    currentlyActive: enabled ? g.snapshot.currentlyActive : false,
    connections: enabled ? g.snapshot.connections : {},
  });

  if (!enabled) return;
  if (!g.interval) {
    const wasRunning = g.running;
    startClaudeWeekendRouting();
    if (wasRunning) g.rerunRequested = true;
    return;
  }
  if (g.running) {
    g.rerunRequested = true;
    return;
  }
  runClaudeWeekendRoutingTick().catch(() => {});
}
