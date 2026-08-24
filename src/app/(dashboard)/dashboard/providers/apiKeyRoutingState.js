export const GLOBAL_PROVIDER_VIEW = "global";

export class ProviderSelectionError extends Error {
  constructor(message = "At least one provider must remain active") {
    super(message);
    this.name = "ProviderSelectionError";
  }
}

export function materializeActiveProviders(apiKey, catalogIds) {
  if (apiKey?.activeProviders === null) return [...catalogIds];

  const catalog = new Set(catalogIds);
  return (apiKey?.activeProviders || []).filter(
    (providerId, index, providers) =>
      catalog.has(providerId) && providers.indexOf(providerId) === index,
  );
}

export function nextActiveProviders(
  apiKey,
  catalogIds,
  providerId,
  nextActive,
) {
  const current = materializeActiveProviders(apiKey, catalogIds);
  const next = nextActive
    ? current.includes(providerId)
      ? current
      : [...current, providerId]
    : current.filter((id) => id !== providerId);

  if (next.length === 0) throw new ProviderSelectionError();
  return next;
}

export async function saveActiveProviders(
  keyId,
  activeProviders,
  fetchImpl = fetch,
) {
  const response = await fetchImpl(`/api/keys/${keyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activeProviders }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || "Save failed");
  }

  return payload.key;
}
