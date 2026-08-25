import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const shutdownEvents = ["beforeExit", "SIGINT", "SIGTERM", "exit"];
let listenersBeforeTest;

beforeEach(() => {
  listenersBeforeTest = new Map(
    shutdownEvents.map((event) => [event, new Set(process.listeners(event))]),
  );
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-providers-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  for (const event of shutdownEvents) {
    const retained = listenersBeforeTest.get(event);
    for (const listener of process.listeners(event)) {
      if (!retained.has(listener)) process.off(event, listener);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API-key provider persistence", () => {
  it("defaults new keys to inherited connection mode", async () => {
    const db = await import("@/lib/db/index.js");
    const key = await db.createApiKey("default-connections", "machine-1");
    expect(key.activeConnections).toBeNull();
    expect((await db.getApiKeyById(key.id)).activeConnections).toBeNull();
  });

  it("round-trips connection mappings through export/import", async () => {
    const db = await import("@/lib/db/index.js");
    const key = await db.createApiKey("scoped", "machine-1");
    const policy = { claude: ["claude-1", "claude-3"] };
    await db.updateApiKey(key.id, { activeConnections: policy });
    const payload = await db.exportDb();
    expect(payload.apiKeys[0].activeConnections).toEqual(policy);
    await db.importDb(payload);
    expect((await db.getApiKeyById(key.id)).activeConnections).toEqual(policy);
  });

  it("treats malformed stored connection policy as inherited", async () => {
    const db = await import("@/lib/db/index.js");
    const key = await db.createApiKey("malformed", "machine-1");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run("UPDATE apiKeys SET activeConnections = ? WHERE id = ?", ["[]", key.id]);
    expect((await db.getApiKeyById(key.id)).activeConnections).toBeNull();
  });

  it("defaults new keys to inherited all-provider mode", async () => {
    const db = await import("@/lib/db/index.js");
    const key = await db.createApiKey("default", "machine-1");
    expect(key.activeProviders).toBeNull();
    expect((await db.getApiKeyByValue(key.key)).activeProviders).toBeNull();
  });

  it("round-trips an explicit provider list", async () => {
    const db = await import("@/lib/db/index.js");
    const key = await db.createApiKey("custom", "machine-1");
    await db.updateApiKey(key.id, { activeProviders: ["claude", "codex"] });
    expect((await db.getApiKeyById(key.id)).activeProviders).toEqual(["claude", "codex"]);
  });

  it("preserves activeProviders through export and import", async () => {
    const db = await import("@/lib/db/index.js");
    const key = await db.createApiKey("portable", "machine-1");
    await db.updateApiKey(key.id, { activeProviders: ["claude"] });
    const payload = await db.exportDb();
    expect(payload.apiKeys[0].activeProviders).toEqual(["claude"]);
    await db.importDb(payload);
    expect((await db.getApiKeyById(key.id)).activeProviders).toEqual(["claude"]);
  });

  it("treats malformed stored JSON as inherited mode", async () => {
    const db = await import("@/lib/db/index.js");
    const key = await db.createApiKey("malformed", "machine-1");
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    adapter.run("UPDATE apiKeys SET activeProviders = ? WHERE id = ?", ["{bad", key.id]);
    expect((await db.getApiKeyById(key.id)).activeProviders).toBeNull();
  });

  it("normalizes malformed valid provider shapes on reads and export", async () => {
    const db = await import("@/lib/db/index.js");
    const keys = await Promise.all([
      db.createApiKey("object", "machine-1"),
      db.createApiKey("empty", "machine-1"),
      db.createApiKey("blank", "machine-1"),
    ]);
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    for (const [key, value] of [[keys[0], "{}"], [keys[1], "[]"], [keys[2], '[""]']]) {
      adapter.run("UPDATE apiKeys SET activeProviders = ? WHERE id = ?", [value, key.id]);
    }

    await expect(Promise.all(keys.map((key) => db.getApiKeyById(key.id))))
      .resolves.toEqual(keys.map((key) => expect.objectContaining({ id: key.id, activeProviders: null })));
    expect((await db.exportDb()).apiKeys.map((key) => key.activeProviders)).toEqual([null, null, null]);
  });

  it("normalizes malformed provider shapes to SQL NULL during import", async () => {
    const db = await import("@/lib/db/index.js");
    await db.importDb({
      apiKeys: [
        { id: "import-object", key: "sk-import-object", activeProviders: {} },
        { id: "import-empty", key: "sk-import-empty", activeProviders: [] },
        { id: "import-blank", key: "sk-import-blank", activeProviders: [""] },
        { id: "import-stringified", key: "sk-import-stringified", activeProviders: '["claude"]' },
      ],
    });
    const adapter = await (await import("@/lib/db/driver.js")).getAdapter();
    const rows = adapter.all("SELECT activeProviders FROM apiKeys ORDER BY id");
    expect(rows.map((row) => row.activeProviders)).toEqual([null, null, null, null]);
    expect((await db.getApiKeys()).map((key) => key.activeProviders)).toEqual([null, null, null, null]);
  });
});
