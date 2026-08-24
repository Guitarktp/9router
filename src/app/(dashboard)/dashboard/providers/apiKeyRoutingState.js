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

export function createActiveProviderSaveCoordinator(
  saveImpl = saveActiveProviders,
) {
  const versions = new Map();
  const queues = new Map();

  return {
    save({ keyId, activeProviders, previousKey, setApiKeys }) {
      const version = (versions.get(keyId) || 0) + 1;
      versions.set(keyId, version);
      const previousOperation = queues.get(keyId) || Promise.resolve();

      const operation = previousOperation.then(async () => {
        try {
          const savedKey = await saveImpl(keyId, activeProviders);
          if (versions.get(keyId) !== version) return { status: "stale" };

          setApiKeys((current) =>
            current.map((key) =>
              key.id === keyId ? { ...key, ...savedKey } : key,
            ),
          );
          return { status: "saved", key: savedKey };
        } catch (error) {
          if (versions.get(keyId) !== version) {
            return { status: "stale", error };
          }

          setApiKeys((current) =>
            current.map((key) => (key.id === keyId ? previousKey : key)),
          );
          throw error;
        }
      });

      const queueTail = operation.catch(() => {});
      queues.set(keyId, queueTail);
      queueTail.finally(() => {
        if (queues.get(keyId) === queueTail) queues.delete(keyId);
      });
      return operation;
    },
  };
}
