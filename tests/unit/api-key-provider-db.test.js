import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-providers-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API-key provider persistence", () => {
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
});
