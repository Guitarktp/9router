import { NextResponse } from "next/server";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";
import { CLAUDE_WEEKEND_ROUTING_CONFIG } from "@/shared/constants/config";
import { getClaudeWeekendRoutingSnapshot } from "@/shared/services/claudeWeekendRouting/service.js";
import { resolveClaudeWeekendRouting } from "@/shared/services/claudeWeekendRouting/policy.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function projectConnectionStatus(status) {
  const result = {
    eligible: status?.eligible === true,
    reason: typeof status?.reason === "string" ? status.reason : "quota_unavailable",
  };
  if (Number.isFinite(Number(status?.remaining))) result.remaining = Number(status.remaining);
  if (typeof status?.resetAt === "string") result.resetAt = status.resetAt;
  if (typeof status?.observedAt === "string") result.observedAt = status.observedAt;
  return result;
}

function projectConnections(connections) {
  return Object.fromEntries(
    Object.entries(connections || {}).map(([id, status]) => [id, projectConnectionStatus(status)]),
  );
}

function hasEligibleConnection(connections, allowedConnectionIds = null) {
  return Object.entries(connections).some(([id, status]) => (
    (allowedConnectionIds === null || allowedConnectionIds.has(id)) && status.eligible === true
  ));
}

function baseResponse(snapshot, connections) {
  return {
    enabled: snapshot?.enabled === true,
    currentlyActive: snapshot?.currentlyActive === true,
    windowStartAt: typeof snapshot?.windowStartAt === "string" ? snapshot.windowStartAt : null,
    windowEndAt: typeof snapshot?.windowEndAt === "string" ? snapshot.windowEndAt : null,
    lastCompletedAt: typeof snapshot?.lastCompletedAt === "string" ? snapshot.lastCompletedAt : null,
    connections,
  };
}

// Existing application middleware authenticates this read-only status endpoint.
export async function GET(request) {
  try {
    const snapshot = getClaudeWeekendRoutingSnapshot();
    const connections = projectConnections(snapshot?.connections);
    const response = baseResponse(snapshot, connections);
    const apiKeyId = new URL(request.url).searchParams.get("apiKeyId");

    if (!apiKeyId) {
      return NextResponse.json({
        ...response,
        hasEligibleConnections: hasEligibleConnection(connections),
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
      enabled: snapshot?.enabled === true,
      now: new Date(),
      maxAgeMs: CLAUDE_WEEKEND_ROUTING_CONFIG.maxObservationAgeMs,
    });

    return NextResponse.json({
      ...response,
      mode: resolved.mode,
      hasEligibleConnections: hasEligibleConnection(connections, resolved.allowedConnectionIds),
    });
  } catch (error) {
    console.warn("[ClaudeWeekendRouting] status failed:", error.message);
    return NextResponse.json({ error: "Unable to load Claude weekend routing status" }, { status: 500 });
  }
}
