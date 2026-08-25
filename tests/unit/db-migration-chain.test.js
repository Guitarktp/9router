// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
    ]));
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [
        { id: "k1", key: "abc", name: "object", activeProviders: {}, createdAt: new Date().toISOString() },
        { id: "k2", key: "def", name: "empty", activeProviders: [], createdAt: new Date().toISOString() },
        { id: "k3", key: "ghi", name: "blank", activeProviders: [""], createdAt: new Date().toISOString() },
        { id: "k4", key: "jkl", name: "stringified", activeProviders: '["claude"]', createdAt: new Date().toISOString() },
      ],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(4);
    expect(keys.map((key) => key.activeProviders)).toEqual([null, null, null, null]);

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("legacy import keeps unrelated data while malformed connection policies become inherited", async () => {
    const createdAt = new Date().toISOString();
    const legacy = {
      settings: { preserved: true },
      providerConnections: [
        { id: "claude-1", provider: "claude", isActive: true },
      ],
      apiKeys: [
        { id: "valid", key: "sk-valid", activeConnections: { cc: ["claude-1"] }, createdAt },
        { id: "array", key: "sk-array", activeConnections: [], createdAt },
        { id: "empty", key: "sk-empty", activeConnections: { claude: [] }, createdAt },
        { id: "duplicate", key: "sk-duplicate", activeConnections: { claude: ["claude-1", "claude-1"] }, createdAt },
        { id: "blank", key: "sk-blank", activeConnections: { claude: [""] }, createdAt },
        { id: "wrong-type", key: "sk-wrong-type", activeConnections: { claude: "claude-1" }, createdAt },
        { id: "malformed-json", key: "sk-malformed", activeConnections: "{bad", createdAt },
      ],
      modelAliases: { preserved: "claude/opus" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    expect(JSON.parse(db.get("SELECT data FROM settings WHERE id = 1").data))
      .toEqual({ preserved: true });
    expect(db.all("SELECT id FROM apiKeys")).toHaveLength(7);
    expect(db.get(
      "SELECT activeConnections FROM apiKeys WHERE id = ?",
      ["valid"],
    ).activeConnections).toBe(JSON.stringify({ claude: ["claude-1"] }));
    expect(db.all(
      "SELECT activeConnections FROM apiKeys WHERE id != ? ORDER BY id",
      ["valid"],
    ).map((row) => row.activeConnections)).toEqual([
      null, null, null, null, null, null,
    ]);
    expect(db.get(
      "SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'preserved'",
    )).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[DB][apiKeys] malformed activeConnections; using inherited mode",
    );
    warn.mockRestore();
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });

  it("backs up and adds activeProviders to an existing API-key table", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt)
       VALUES(?, ?, ?, ?, ?, ?)`,
      ["legacy-key", "sk-legacy", "Legacy", "machine-1", 1, new Date().toISOString()],
    );
    db.exec("ALTER TABLE apiKeys DROP COLUMN activeProviders");
    db.run(
      `INSERT INTO _meta(key, value) VALUES('backupSchemaVersion', '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
    );
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();

    const columns = db2.all("PRAGMA table_info(apiKeys)").map((column) => column.name);
    expect(columns).toContain("activeProviders");
    expect(db2.get(
      "SELECT activeProviders FROM apiKeys WHERE id = ?",
      ["legacy-key"],
    ).activeProviders).toBeNull();

    const backupRoot = path.join(tempDir, "db", "backups");
    const schemaBackups = fs.readdirSync(backupRoot)
      .filter((name) => name.startsWith("schema-1-to-3-"));
    expect(schemaBackups).toHaveLength(1);
    expect(fs.existsSync(path.join(backupRoot, schemaBackups[0], "data.sqlite"))).toBe(true);
  });
});
