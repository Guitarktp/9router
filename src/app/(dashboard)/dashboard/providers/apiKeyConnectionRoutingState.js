export class ConnectionSelectionError extends Error {
  constructor(message = "At least one connection must remain active") {
    super(message);
    this.name = "ConnectionSelectionError";
  }
}

export function getProviderConnectionMode(apiKey, providerId) {
  return Array.isArray(apiKey?.activeConnections?.[providerId])
    ? "custom"
    : "inherit";
}

export function materializeConnectionSelection(
  apiKey,
  providerId,
  connections,
) {
  const configured = apiKey?.activeConnections?.[providerId];
  if (Array.isArray(configured)) return [...configured];

  return connections
    .filter((connection) => connection.isActive !== false)
    .map((connection) => connection.id);
}

export function effectiveConnectionIds(apiKey, providerId, connections) {
  const activeConnectionIds = new Set(
    connections
      .filter((connection) => connection.isActive !== false)
      .map((connection) => connection.id),
  );

  return materializeConnectionSelection(apiKey, providerId, connections).filter(
    (connectionId) => activeConnectionIds.has(connectionId),
  );
}

export function setProviderConnectionMode(
  apiKey,
  providerId,
  mode,
  connections,
) {
  const activeConnections = apiKey?.activeConnections || {};

  if (mode === "custom") {
    const selectedConnectionIds = connections
      .filter((connection) => connection.isActive !== false)
      .map((connection) => connection.id);
    if (selectedConnectionIds.length === 0) throw new ConnectionSelectionError();

    return { ...activeConnections, [providerId]: selectedConnectionIds };
  }

  if (mode === "inherit") {
    const next = { ...activeConnections };
    delete next[providerId];
    return Object.keys(next).length === 0 ? null : next;
  }

  throw new ConnectionSelectionError(`Unsupported connection mode: ${mode}`);
}

export function nextActiveConnections(
  apiKey,
  providerId,
  connectionId,
  nextActive,
  connections,
) {
  const current = materializeConnectionSelection(apiKey, providerId, connections);

  if (nextActive) {
    const connection = connections.find(({ id }) => id === connectionId);
    if (!connection || connection.isActive === false) {
      throw new ConnectionSelectionError("Connection is globally disabled");
    }
    return current.includes(connectionId) ? current : [...current, connectionId];
  }

  const next = current.filter((id) => id !== connectionId);
  if (next.length === 0) throw new ConnectionSelectionError();
  return next;
}

export async function saveActiveConnections(
  keyId,
  activeConnections,
  fetchImpl = fetch,
) {
  const response = await fetchImpl(`/api/keys/${keyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activeConnections }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || "Save failed");
  }

  return payload.key;
}

export function createActiveConnectionSaveCoordinator(
  saveImpl = saveActiveConnections,
) {
  const versions = new Map();
  const queues = new Map();
  const confirmedKeys = new Map();

  return {
    save({ keyId, activeConnections, previousKey, setApiKeys }) {
      if (!confirmedKeys.has(keyId)) confirmedKeys.set(keyId, previousKey);
      const version = (versions.get(keyId) || 0) + 1;
      versions.set(keyId, version);
      const previousOperation = queues.get(keyId) || Promise.resolve();

      const operation = previousOperation.then(async () => {
        try {
          const savedKey = await saveImpl(keyId, activeConnections);
          confirmedKeys.set(keyId, savedKey);
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

          const confirmedKey = confirmedKeys.get(keyId) || previousKey;
          setApiKeys((current) =>
            current.map((key) => (key.id === keyId ? confirmedKey : key)),
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
