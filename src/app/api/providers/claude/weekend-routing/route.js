import { NextResponse } from "next/server";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { CLAUDE_WEEKEND_ROUTING_CONFIG } from "@/shared/constants/config";
import { getClaudeWeekendRoutingSnapshot } from "@/shared/services/claudeWeekendRouting/state.js";
import {
  evaluateClaudeWeeklyQuota,
  resolveClaudeWeekendRouting,
} from "@/shared/services/claudeWeekendRouting/policy.js";
import { getClaudeWeekendWindow } from "@/shared/services/claudeWeekendRouting/window.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function projectConnectionStatus(status, now, windowEndAt) {
  const evaluated = status?.eligible === true
    ? evaluateClaudeWeeklyQuota({
      quota: status,
      observedAt: status.observedAt,
      now,
      windowEndAt,
      maxAgeMs: CLAUDE_WEEKEND_ROUTING_CONFIG.maxObservationAgeMs,
    })
    : status;
  const result = {
    eligible: evaluated?.eligible === true,
    reason: typeof evaluated?.reason === "string" ? evaluated.reason : "quota_unavailable",
  };
  if (Number.isFinite(Number(evaluated?.remaining))) result.remaining = Number(evaluated.remaining);
  if (typeof evaluated?.resetAt === "string") result.resetAt = evaluated.resetAt;
  if (typeof evaluated?.observedAt === "string") result.observedAt = evaluated.observedAt;
  return result;
}

function projectConnections(connections, now, windowEndAt) {
  return Object.fromEntries(
    Object.entries(connections || {}).map(([id, status]) => [
      id,
      projectConnectionStatus(status, now, windowEndAt),
    ]),
  );
}

function hasEligibleConnection(connections, allowedConnectionIds = null) {
  return Object.entries(connections).some(([id, status]) => (
    (allowedConnectionIds === null || allowedConnectionIds.has(id)) && status.eligible === true
  ));
}

function baseResponse(snapshot, connections, window) {
  const enabled = snapshot?.enabled === true;
  return {
    enabled,
    currentlyActive: enabled && window.active,
    windowStartAt: window.startAt,
    windowEndAt: window.endAt,
    lastCompletedAt: typeof snapshot?.lastCompletedAt === "string" ? snapshot.lastCompletedAt : null,
    connections,
  };
}

// Existing application middleware authenticates this read-only status endpoint.
export async function GET(request) {
  try {
    const snapshot = getClaudeWeekendRoutingSnapshot();
    const now = new Date();
    const window = getClaudeWeekendWindow(now);
    const connections = projectConnections(snapshot?.connections, now, window.endAt);
    const response = baseResponse(snapshot, connections, window);
    const apiKeyId = new URL(request.url).searchParams.get("apiKeyId");

    if (apiKeyId === null) {
      return NextResponse.json({
        ...response,
        hasEligibleConnections: response.currentlyActive && hasEligibleConnection(connections),
      });
    }

    const apiKey = (await getApiKeys()).find((key) => key.id === apiKeyId);
    if (!apiKey) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const storedConnections = await getProviderConnections({ provider: "claude", isActive: true });
    const safeConnections = storedConnections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      isActive: connection.isActive === true,
    }));
    const configured = apiKey.activeConnections?.claude;
    const baseAllowedConnectionIds = Array.isArray(configured) ? new Set(configured) : null;
    const resolved = resolveClaudeWeekendRouting({
      providerId: "claude",
      baseAllowedConnectionIds,
      globalConnections: safeConnections,
      snapshot,
      enabled: response.enabled,
      now,
      maxAgeMs: CLAUDE_WEEKEND_ROUTING_CONFIG.maxObservationAgeMs,
    });

    return NextResponse.json({
      ...response,
      mode: resolved.mode,
      hasEligibleConnections: response.currentlyActive
        && hasEligibleConnection(connections, resolved.allowedConnectionIds),
    });
  } catch (error) {
    console.warn("[ClaudeWeekendRouting] status failed:", error.message);
    return NextResponse.json({ error: "Unable to load Claude weekend routing status" }, { status: 500 });
  }
}
