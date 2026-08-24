import { getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId, WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers";

const COMPATIBLE_NODE_TYPES = new Set(["openai-compatible", "anthropic-compatible"]);
const WEB_COOKIE_PROVIDER_IDS = new Set(Object.keys(WEB_COOKIE_PROVIDERS));

export function buildRoutableProviderIds(nodes = []) {
  const ids = new Set(
    Object.values(AI_PROVIDERS)
      .filter(
        (provider) =>
          !provider.hidden &&
          !WEB_COOKIE_PROVIDER_IDS.has(provider.id) &&
          (provider.serviceKinds ?? ["llm"]).includes("llm"),
      )
      .map((provider) => provider.id),
  );

  for (const node of nodes) {
    if (node?.id && COMPATIBLE_NODE_TYPES.has(node.type)) ids.add(node.id);
  }

  return [...ids].sort();
}

export async function getRoutableProviderIds() {
  return buildRoutableProviderIds(await getProviderNodes());
}

export class ActiveProviderValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActiveProviderValidationError";
    this.code = code;
    this.status = 400;
  }
}

export async function normalizeActiveProviderInput(value) {
  if (!Array.isArray(value)) {
    throw new ActiveProviderValidationError("invalid_active_providers", "activeProviders must be an array");
  }
  if (value.length === 0) {
    throw new ActiveProviderValidationError("at_least_one_provider_required", "At least one provider is required");
  }

  const routableIds = new Set(await getRoutableProviderIds());
  const canonicalIds = [];
  const seen = new Set();

  for (const providerId of value) {
    if (typeof providerId !== "string" || !providerId.trim()) {
      throw new ActiveProviderValidationError("invalid_active_providers", "Provider IDs must be non-empty strings");
    }

    const canonicalId = resolveProviderId(providerId.trim());
    if (!routableIds.has(canonicalId)) {
      throw new ActiveProviderValidationError("invalid_active_providers", `Unknown provider: ${providerId}`);
    }
    if (seen.has(canonicalId)) {
      throw new ActiveProviderValidationError("invalid_active_providers", `Duplicate provider: ${canonicalId}`);
    }

    seen.add(canonicalId);
    canonicalIds.push(canonicalId);
  }

  return canonicalIds;
}
