import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export function parseActiveProviders(value) {
  if (value == null) return null;
  const parsed = parseJson(value, null);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((id) => typeof id !== "string" || !id.trim())) {
    console.warn("[DB][apiKeys] malformed activeProviders; using inherited mode");
    return null;
  }
  return [...new Set(parsed)];
}

export function parseActiveConnections(value) {
  if (value == null) return null;
  const parsed = parseJson(value, null);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    console.warn("[DB][apiKeys] malformed activeConnections; using inherited mode");
    return null;
  }
  const normalized = {};
  for (const [providerId, ids] of Object.entries(parsed)) {
    if (!providerId.trim() || !Array.isArray(ids) || ids.length === 0) {
      console.warn("[DB][apiKeys] malformed activeConnections; using inherited mode");
      return null;
    }
    if (ids.some((id) => typeof id !== "string" || !id.trim())) {
      console.warn("[DB][apiKeys] malformed activeConnections; using inherited mode");
      return null;
    }
    normalized[providerId] = [...new Set(ids)];
  }
  return Object.keys(normalized).length === 0 ? null : normalized;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    activeProviders: parseActiveProviders(row.activeProviders),
    activeConnections: parseActiveConnections(row.activeConnections),
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByValue(key) {
  if (!key) return null;
  const db = await getAdapter();
  return rowToKey(db.get("SELECT * FROM apiKeys WHERE key = ?", [key]));
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    activeProviders: null,
    activeConnections: null,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, activeProviders, activeConnections, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, null, null, apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  if (Object.hasOwn(data, "activeProviders")) {
    if (data.activeProviders !== null &&
        (!Array.isArray(data.activeProviders) || data.activeProviders.length === 0 ||
         data.activeProviders.some((provider) => typeof provider !== "string" || !provider.trim()))) {
      throw new TypeError("activeProviders must be null or a non-empty array");
    }
  }
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, activeProviders = ?, activeConnections = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.activeProviders === null ? null : stringifyJson(merged.activeProviders), merged.activeConnections === null ? null : stringifyJson(merged.activeConnections), id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
