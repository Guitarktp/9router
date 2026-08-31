/**
 * Claude usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";

// Claude API config (urls from registry, apiVersion is header logic kept here)
const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  usageUrl: U("claude").orgUrl,
  settingsUrl: U("claude").settingsUrl,
  apiVersion: ANTHROPIC_API_VERSION,
};

// OAuth usage endpoint rate-limits (429); cool down per-token to stop hammering it.
// Only the quota endpoint is affected — chat with the same token still works.
const OAUTH_429_COOLDOWN_MS = 180000;
const oauthCooldown = new Map();

// Dedup + short TTL cache per access token. Many tabs / many accounts / auto-refresh
// all funnel through here; without this each call hits Anthropic and triggers 429.
const USAGE_CACHE_TTL_MS = 300000;
const usageCache = new Map(); // token -> { promise } | { result, observedAt, expiresAt, stale? }

export async function getClaudeUsageObservation(accessToken, proxyOptions = null, options = {}) {
  const force = options?.force === true;
  const hit = accessToken ? usageCache.get(accessToken) : null;

  // Serve in-flight or fresh cached result (skip on manual force)
  if (!force && hit?.promise) {
    return hit.promise;
  }
  if (!force && hit?.result && hit.expiresAt > Date.now()) {
    return {
      result: hit.result,
      observedAt: hit.observedAt,
      source: hit.stale === true ? "stale" : "cache",
      stale: hit.stale === true,
    };
  }

  const staleEntry = !force && hit?.result ? hit : null;

  const promise = (async () => {
    const result = await fetchClaudeUsageRaw(accessToken, proxyOptions);
    const ownsCache = () => accessToken && usageCache.get(accessToken)?.promise === promise;

    // Only record a fresh observation for real quota data, not soft failures.
    if (result?.quotas) {
      const observedAt = new Date().toISOString();
      if (ownsCache()) {
        usageCache.set(accessToken, {
          result,
          observedAt,
          expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
        });
      }
      return { result, observedAt, source: "upstream", stale: false };
    }
    // Soft failure (429/error): prefer the last good read with its original time.
    if (staleEntry) {
      if (ownsCache()) {
        usageCache.set(accessToken, {
          ...staleEntry,
          stale: true,
          expiresAt: Date.now() + OAUTH_429_COOLDOWN_MS,
        });
      }
      return {
        result: staleEntry.result,
        observedAt: staleEntry.observedAt,
        source: "stale",
        stale: true,
      };
    }
    return { result, observedAt: null, source: "upstream", stale: false };
  })();

  if (accessToken) usageCache.set(accessToken, { promise });
  try {
    return await promise;
  } finally {
    // A thrown fetch must not leave a rejected in-flight promise cached.
    if (accessToken && usageCache.get(accessToken)?.promise === promise) {
      usageCache.delete(accessToken);
    }
  }
}

export async function getClaudeUsage(accessToken, proxyOptions = null, options = {}) {
  return (await getClaudeUsageObservation(accessToken, proxyOptions, options)).result;
}

async function fetchClaudeUsageRaw(accessToken, proxyOptions = null) {
  try {
    // Skip OAuth usage call while this token is cooling down from a recent 429
    const cooldownUntil = oauthCooldown.get(accessToken);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return await getClaudeUsageLegacy(accessToken, proxyOptions);
    }

    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    const oauthResponse = await proxyAwareFetch(CLAUDE_CONFIG.oauthUsageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      return {
        plan: "Claude Code",
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
    }

    // Cool down OAuth usage polling after a 429 (quota endpoint only)
    if (oauthResponse.status === 429) {
      oauthCooldown.set(accessToken, Date.now() + OAUTH_429_COOLDOWN_MS);
    }

    // Fallback: legacy settings + org usage endpoint
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    return await getClaudeUsageLegacy(accessToken, proxyOptions);
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}
