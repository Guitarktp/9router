import { getApiKeyByValue } from "@/lib/localDb";
import { getModelInfo } from "@/sse/services/model.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

export const ROUTING_MODE = Object.freeze({
  UNRESTRICTED: "unrestricted",
  RESTRICTED: "restricted",
});

export async function resolveApiKeyRoutingContext({
  apiKey,
  requireApiKey,
  lookup = getApiKeyByValue,
}) {
  if (!apiKey) {
    return requireApiKey
      ? { ok: false, status: 401, message: "Missing API key" }
      : { ok: true, mode: ROUTING_MODE.UNRESTRICTED, key: null };
  }

  const key = await lookup(apiKey);
  if (!key?.isActive) {
    return requireApiKey
      ? { ok: false, status: 401, message: "Invalid API key" }
      : { ok: true, mode: ROUTING_MODE.UNRESTRICTED, key: null };
  }

  const baseContext = {
    ok: true,
    key,
    activeConnections: key.activeConnections || null,
  };

  if (key.activeProviders === null) {
    return { ...baseContext, mode: ROUTING_MODE.UNRESTRICTED };
  }

  return {
    ...baseContext,
    mode: ROUTING_MODE.RESTRICTED,
    activeProviders: new Set(key.activeProviders),
  };
}

export function getAllowedConnectionIds(context, providerId) {
  const canonicalId = resolveProviderId(providerId);
  const configured = context?.activeConnections?.[canonicalId];
  return Array.isArray(configured) ? new Set(configured) : null;
}

export function isProviderActive(context, providerId) {
  return context.mode === ROUTING_MODE.UNRESTRICTED || context.activeProviders?.has(providerId) === true;
}

export async function filterModelCandidates(models, context, resolveModelInfo = getModelInfo) {
  if (context.mode === ROUTING_MODE.UNRESTRICTED) return models;

  const allowedModels = [];
  for (const model of models) {
    const modelInfo = await resolveModelInfo(model);
    if (modelInfo?.provider && isProviderActive(context, modelInfo.provider)) {
      allowedModels.push(model);
    }
  }
  return allowedModels;
}
