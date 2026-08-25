import { getProviderConnections } from "@/lib/localDb";
import { getRoutableProviderIds } from "@/lib/apiKeyProviderCatalog";
import { resolveProviderAlias } from "open-sse/services/model.js";

export class ActiveConnectionValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActiveConnectionValidationError";
    this.code = code;
    this.status = 400;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(code, message) {
  return new ActiveConnectionValidationError(code, message);
}

function getPreviousSelections(value) {
  const selections = new Map();
  if (!isPlainObject(value)) return selections;

  for (const [providerId, connectionIds] of Object.entries(value)) {
    if (!Array.isArray(connectionIds)) continue;
    const canonicalProviderId = resolveProviderAlias(providerId);
    const providerSelections = selections.get(canonicalProviderId) ?? new Set();
    for (const connectionId of connectionIds) {
      if (typeof connectionId === "string") providerSelections.add(connectionId);
    }
    selections.set(canonicalProviderId, providerSelections);
  }

  return selections;
}

function getDependencies(deps = {}) {
  return {
    getProviderIds: deps.getProviderIds ?? getRoutableProviderIds,
    getConnections: deps.getConnections ?? getProviderConnections,
  };
}

export async function normalizeActiveConnectionInput(value, previousValue, deps) {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw validationError("invalid_active_connections", "activeConnections must be an object or null");
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return null;

  const { getProviderIds, getConnections } = getDependencies(deps);
  const [providerIds, connections] = await Promise.all([getProviderIds(), getConnections()]);
  const routableProviderIds = new Set(providerIds);
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const previousSelections = getPreviousSelections(previousValue);
  const normalized = {};
  const seenProviders = new Set();

  for (const [providerId, connectionIds] of entries) {
    if (typeof providerId !== "string" || !providerId.trim()) {
      throw validationError("invalid_active_connections", "Provider IDs must be non-empty strings");
    }

    const canonicalProviderId = resolveProviderAlias(providerId.trim());
    if (!routableProviderIds.has(canonicalProviderId)) {
      throw validationError("invalid_active_connections", `Unknown provider: ${providerId}`);
    }
    if (seenProviders.has(canonicalProviderId)) {
      throw validationError("invalid_active_connections", `Duplicate provider: ${canonicalProviderId}`);
    }
    if (!Array.isArray(connectionIds)) {
      throw validationError("invalid_active_connections", "Connection IDs must be arrays");
    }
    if (connectionIds.length === 0) {
      throw validationError("at_least_one_connection_required", "At least one connection is required");
    }

    const seenConnections = new Set();
    const normalizedConnectionIds = [];
    for (const connectionId of connectionIds) {
      if (typeof connectionId !== "string" || !connectionId.trim() || seenConnections.has(connectionId)) {
        throw validationError("invalid_active_connections", "Connection IDs must be unique non-empty strings");
      }

      const connection = connectionsById.get(connectionId);
      if (
        !connection
        || resolveProviderAlias(connection.provider) !== canonicalProviderId
      ) {
        throw validationError("invalid_active_connections", `Invalid connection: ${connectionId}`);
      }
      if (
        connection.isActive === false
        && !previousSelections.get(canonicalProviderId)?.has(connectionId)
      ) {
        throw validationError("connection_globally_inactive", `Connection is inactive: ${connectionId}`);
      }

      seenConnections.add(connectionId);
      normalizedConnectionIds.push(connectionId);
    }

    seenProviders.add(canonicalProviderId);
    normalized[canonicalProviderId] = normalizedConnectionIds;
  }

  return normalized;
}

export async function intersectApiKeysWithCurrentConnections(keys, deps) {
  const keyList = Array.isArray(keys) ? keys : [];
  if (!keyList.some((key) => isPlainObject(key?.activeConnections))) return keyList;

  const { getConnections } = getDependencies(deps);
  const connectionsById = new Map((await getConnections()).map((connection) => [connection.id, connection]));

  return keyList.map((key) => {
    if (!isPlainObject(key?.activeConnections)) return key;

    const activeConnections = Object.fromEntries(
      Object.entries(key.activeConnections).map(([providerId, connectionIds]) => [
        providerId,
        Array.isArray(connectionIds)
          ? connectionIds.filter((connectionId) => {
            const connection = connectionsById.get(connectionId);
            return connection && resolveProviderAlias(connection.provider) === providerId;
          })
          : [],
      ]),
    );

    return { ...key, activeConnections };
  });
}
