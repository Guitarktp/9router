import { getApiKeyByValue } from "@/lib/localDb";
import { getModelInfo } from "@/sse/services/model.js";

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

  if (key.activeProviders === null) {
    return { ok: true, mode: ROUTING_MODE.UNRESTRICTED, key };
  }

  return {
    ok: true,
    mode: ROUTING_MODE.RESTRICTED,
    key,
    activeProviders: new Set(key.activeProviders),
  };
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
