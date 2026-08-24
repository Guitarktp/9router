# API-Key-Specific Provider Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each endpoint API key select an independent non-empty set of active LLM providers while preserving 9router's current global connection, credential, combo, local-mode, and media behavior.

**Architecture:** Persist a nullable JSON allowlist on each API-key row, resolve it once into a request-scoped routing context, and apply that context before direct-provider dispatch, during combo/capacity filtering, and while building `/v1/models`. Keep provider-catalog validation and routing policy in focused server modules, while the existing Providers page gets a Global/API-key view selector and optimistic autosave controls.

**Tech Stack:** Next.js 16 App Router, React 19, JavaScript ES modules, SQLite through the existing adapter layer, Vitest 4, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-08-24-api-key-provider-routing-design.md`

## Global Constraints

- Do not add runtime or test dependencies.
- `apiKeys.activeProviders = NULL` means all current LLM providers are active.
- An explicit `activeProviders` value is a non-empty JSON array of canonical provider IDs.
- Existing keys, new keys, and local requests without a recognized active endpoint key must preserve current all-provider behavior.
- Customized keys must not activate providers introduced by a later 9router version.
- A direct inactive-provider request returns HTTP 403 with code `provider_not_active_for_api_key`.
- A combo with no active candidates returns HTTP 403 with code `no_active_combo_providers_for_api_key`.
- Global provider connection state, credentials, retries, quotas, translation, streaming, Media Providers, and Proxy Pools are unchanged.
- The Providers page always opens in `Global connections` mode.
- Use test-driven development: observe each new focused test fail before implementing its production behavior.
- The upstream full suite has known baseline failures; completion means no new failures, not necessarily an all-green upstream suite.

## File Structure

### New focused modules

- `src/lib/apiKeyProviderCatalog.js` — constructs the current routable LLM-provider catalog and validates canonical non-empty provider arrays.
- `src/sse/services/apiKeyRouting.js` — resolves request API-key routing contexts and answers/filter provider policy decisions.
- `src/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js` — pure dashboard state transitions and the API update helper.
- `src/app/(dashboard)/dashboard/providers/components/ProviderRoutingContextBar.js` — Global/API-key selector and active-count presentation.

### New focused tests

- `tests/unit/api-key-provider-db.test.js` — persistence, malformed-value fallback, and export/import behavior.
- `tests/unit/api-key-provider-catalog.test.js` — built-in/dynamic catalog and API input validation.
- `tests/unit/api-key-routing-policy.test.js` — optional/required auth contexts, direct policy, ordered candidate filtering, and custom error codes.
- `tests/unit/api-key-chat-routing.test.js` — direct, combo, capacity-adapter, and final-guard behavior through `handleChat`.
- `tests/unit/api-key-model-list.test.js` — restricted direct models and combo visibility.
- `tests/unit/api-key-provider-ui-state.test.js` — inherited-state materialization, last-provider guard, request payloads, and save failures.

### Existing files modified

- `src/lib/db/schema.js` — bump `SCHEMA_VERSION` from `1` to `2`; add nullable `activeProviders` column.
- `src/lib/db/repos/apiKeysRepo.js` — serialize/deserialize allowlists and add key-value lookup.
- `src/lib/db/migrate.js` — preserve allowlists during legacy import.
- `src/lib/db/index.js` — export/import allowlists and export the new repository lookup.
- `src/lib/localDb.js` — re-export the new lookup.
- `src/app/api/keys/[id]/route.js` — validate and persist `activeProviders` partial updates.
- `open-sse/utils/error.js` — support an optional stable error-code override without changing existing callers.
- `src/sse/handlers/chat.js` — resolve one routing context and enforce it across direct/combo/adapter/fusion dispatch.
- `src/app/api/v1/models/route.js` — apply the same context to direct models and combos.
- `src/app/(dashboard)/dashboard/providers/page.js` — fetch keys, switch control modes, and autosave key-specific provider state.

---

### Task 1: Persist API-key provider allowlists safely

**Files:**
- Create: `tests/unit/api-key-provider-db.test.js`
- Modify: `tests/unit/db-migration-chain.test.js`
- Modify: `src/lib/db/schema.js:1-90`
- Modify: `src/lib/db/repos/apiKeysRepo.js:1-75`
- Modify: `src/lib/db/migrate.js:143-149`
- Modify: `src/lib/db/index.js:1-150`
- Modify: `src/lib/localDb.js:1-30`

**Interfaces:**
- Produces: `getApiKeyByValue(key: string): Promise<ApiKey|null>`.
- Produces: `ApiKey.activeProviders: null|string[]` on every API-key read.
- Produces: `updateApiKey(id, { activeProviders })`, where `activeProviders` is `null` or a non-empty string array.
- Consumes: existing `parseJson` and `stringifyJson` helpers.

- [ ] **Step 1: Write failing persistence and export/import tests**

Create `tests/unit/api-key-provider-db.test.js` using the same temporary `DATA_DIR`, singleton reset, and cleanup pattern as `db-sqlite-vs-lowdb.test.js`:

```js
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
```

Extend `tests/unit/db-migration-chain.test.js` with a full restart test that simulates a version-1 database missing the new column, proves the pre-schema backup is created, and verifies the row survives additive sync:

```js
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
    .filter((name) => name.startsWith("schema-1-to-2-"));
  expect(schemaBackups).toHaveLength(1);
  expect(fs.existsSync(path.join(backupRoot, schemaBackups[0], "data.sqlite"))).toBe(true);
});
```

- [ ] **Step 2: Run the tests and confirm the missing column/API failures**

Run:

```bash
npm --prefix tests test -- unit/api-key-provider-db.test.js unit/db-migration-chain.test.js
```

Expected: FAIL because `activeProviders` and `getApiKeyByValue` do not exist.

- [ ] **Step 3: Add the schema and repository serialization**

In `src/lib/db/schema.js`, set `SCHEMA_VERSION = 2` and add:

```js
activeProviders: "TEXT",
```

In `apiKeysRepo.js`, import `parseJson`/`stringifyJson`, add a defensive parser, include the property in `rowToKey`, and add value lookup:

```js
function parseActiveProviders(value) {
  if (value == null) return null;
  const parsed = parseJson(value, null);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || !id.trim())) {
    console.warn("[DB][apiKeys] malformed activeProviders; using inherited mode");
    return null;
  }
  return [...new Set(parsed)];
}

export async function getApiKeyByValue(key) {
  if (!key) return null;
  const db = await getAdapter();
  return rowToKey(db.get("SELECT * FROM apiKeys WHERE key = ?", [key]));
}
```

Use SQL `NULL` for inherited mode and JSON text for explicit mode. Preserve `activeProviders` when `updateApiKey` receives only `{ isActive }`, and reject a supplied empty/non-array value before opening the update transaction:

```js
if (Object.hasOwn(data, "activeProviders")) {
  if (data.activeProviders !== null &&
      (!Array.isArray(data.activeProviders) || data.activeProviders.length === 0)) {
    throw new TypeError("activeProviders must be null or a non-empty array");
  }
}
```

- [ ] **Step 4: Extend migration, export, import, and public barrels**

Add `activeProviders` to the legacy-import insert in `migrate.js`, using `NULL` for absent values and `stringifyJson` for arrays. Add the same column to `exportDb` and `importDb` SQL in `db/index.js`. Export `getApiKeyByValue` from both `db/index.js` and `localDb.js`.

The import expression must distinguish absent/`null` from an explicit list:

```js
const activeProviders = Array.isArray(k.activeProviders)
  ? stringifyJson(k.activeProviders)
  : null;
```

- [ ] **Step 5: Run focused DB tests**

Run:

```bash
npm --prefix tests test -- unit/api-key-provider-db.test.js unit/db-migration-chain.test.js unit/db-sqlite-vs-lowdb.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/lib/db/schema.js src/lib/db/repos/apiKeysRepo.js src/lib/db/migrate.js src/lib/db/index.js src/lib/localDb.js tests/unit/api-key-provider-db.test.js tests/unit/db-migration-chain.test.js
git commit -m "feat: persist provider routing per API key"
```

---

### Task 2: Build one provider catalog and validate API updates

**Files:**
- Create: `src/lib/apiKeyProviderCatalog.js`
- Create: `tests/unit/api-key-provider-catalog.test.js`
- Modify: `src/app/api/keys/[id]/route.js:1-55`

**Interfaces:**
- Consumes: `AI_PROVIDERS`, `resolveProviderId`, and `getProviderNodes()`.
- Produces: `buildRoutableProviderIds(nodes: ProviderNode[]): string[]`.
- Produces: `getRoutableProviderIds(): Promise<string[]>`.
- Produces: `normalizeActiveProviderInput(value): Promise<string[]>`.
- Produces: `ActiveProviderValidationError` with `code` and HTTP status 400.

- [ ] **Step 1: Write failing catalog tests**

Create `tests/unit/api-key-provider-catalog.test.js` with a mocked node repository:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getProviderNodes: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderNodes: mocks.getProviderNodes }));

describe("API-key provider catalog", () => {
  beforeEach(() => {
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-team", type: "openai-compatible", prefix: "team" },
      { id: "custom-embedding-x", type: "custom-embedding", prefix: "embed" },
    ]);
  });

  it("contains visible built-in LLM providers and compatible nodes only", async () => {
    const { getRoutableProviderIds } = await import("@/lib/apiKeyProviderCatalog.js");
    const ids = await getRoutableProviderIds();
    expect(ids).toContain("claude");
    expect(ids).toContain("openai-compatible-team");
    expect(ids).not.toContain("custom-embedding-x");
  });

  it("canonicalizes aliases and rejects duplicates after canonicalization", async () => {
    const { normalizeActiveProviderInput } = await import("@/lib/apiKeyProviderCatalog.js");
    await expect(normalizeActiveProviderInput(["cc", "claude"])).rejects.toMatchObject({
      code: "invalid_active_providers",
    });
  });

  it("rejects empty and unknown provider lists", async () => {
    const { normalizeActiveProviderInput } = await import("@/lib/apiKeyProviderCatalog.js");
    await expect(normalizeActiveProviderInput([])).rejects.toMatchObject({
      code: "at_least_one_provider_required",
    });
    await expect(normalizeActiveProviderInput(["missing-provider"])).rejects.toMatchObject({
      code: "invalid_active_providers",
    });
  });
});
```

- [ ] **Step 2: Run the catalog tests and observe the missing module**

Run:

```bash
npm --prefix tests test -- unit/api-key-provider-catalog.test.js
```

Expected: FAIL because `apiKeyProviderCatalog.js` does not exist.

- [ ] **Step 3: Implement the focused catalog module**

Use the registry's `serviceKinds` convention and include only compatible dynamic node types:

```js
import { getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers";

const COMPATIBLE_NODE_TYPES = new Set(["openai-compatible", "anthropic-compatible"]);

export function buildRoutableProviderIds(nodes = []) {
  const ids = new Set(
    Object.values(AI_PROVIDERS)
      .filter((p) => !p.hidden && (p.serviceKinds ?? ["llm"]).includes("llm"))
      .map((p) => p.id),
  );
  for (const node of nodes) {
    if (node?.id && COMPATIBLE_NODE_TYPES.has(node.type)) ids.add(node.id);
  }
  return [...ids].sort();
}

export class ActiveProviderValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActiveProviderValidationError";
    this.code = code;
    this.status = 400;
  }
}
```

`normalizeActiveProviderInput` must reject non-arrays, empty arrays, blank IDs, unknown IDs, and duplicates after `resolveProviderId`. Return canonical IDs in request order.

- [ ] **Step 4: Write failing API-route tests for partial updates**

Append route tests to the same test file. Mock `next/server`, `getApiKeyById`, `updateApiKey`, and `normalizeActiveProviderInput`, then assert:

```js
const req = new Request("http://localhost/api/keys/key-1", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ activeProviders: ["cc", "codex"] }),
});
const res = await PUT(req, { params: Promise.resolve({ id: "key-1" }) });
expect(mocks.updateApiKey).toHaveBeenCalledWith("key-1", {
  activeProviders: ["claude", "codex"],
});
expect(res.status).toBe(200);
```

Also assert a thrown `ActiveProviderValidationError` returns status 400 and its stable code without calling `updateApiKey`; an `{ isActive: false }` request continues to work without catalog validation.

- [ ] **Step 5: Extend `PUT /api/keys/[id]`**

Keep the existing existence check and `isActive` partial update. When the JSON body owns `activeProviders`, call `normalizeActiveProviderInput` and place the returned array in `updateData`. Catch `ActiveProviderValidationError` separately:

```js
return NextResponse.json(
  { error: { code: error.code, message: error.message } },
  { status: error.status },
);
```

Unknown keys remain HTTP 404; unexpected errors remain HTTP 500.

- [ ] **Step 6: Run catalog and API-route tests**

Run:

```bash
npm --prefix tests test -- unit/api-key-provider-catalog.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/lib/apiKeyProviderCatalog.js src/app/api/keys/'[id]'/route.js tests/unit/api-key-provider-catalog.test.js
git commit -m "feat: validate API-key provider selections"
```

---

### Task 3: Add request-scoped routing policy and stable custom error codes

**Files:**
- Create: `src/sse/services/apiKeyRouting.js`
- Create: `tests/unit/api-key-routing-policy.test.js`
- Modify: `open-sse/utils/error.js:1-60`

**Interfaces:**
- Consumes: `getApiKeyByValue(key)` from Task 1.
- Consumes: `getModelInfo(model)` for canonical provider resolution.
- Produces: `resolveApiKeyRoutingContext({ apiKey, requireApiKey, lookup? })`.
- Produces: `isProviderActive(context, providerId): boolean`.
- Produces: `filterModelCandidates(models, context, resolveModelInfo?): Promise<string[]>`.
- Produces: `ROUTING_MODE.UNRESTRICTED` and `ROUTING_MODE.RESTRICTED`.
- Extends: `buildErrorBody(status, message, overrides?)` and `errorResponse(status, message, overrides?)`.

- [ ] **Step 1: Write failing context and filtering tests**

Create `tests/unit/api-key-routing-policy.test.js`:

```js
import { describe, expect, it, vi } from "vitest";

describe("API-key routing policy", () => {
  it("keeps optional local mode unrestricted for an unknown key", async () => {
    const { resolveApiKeyRoutingContext } = await import("@/sse/services/apiKeyRouting.js");
    const context = await resolveApiKeyRoutingContext({
      apiKey: "unknown",
      requireApiKey: false,
      lookup: vi.fn().mockResolvedValue(null),
    });
    expect(context).toMatchObject({ ok: true, mode: "unrestricted" });
  });

  it("rejects an unknown key when API keys are required", async () => {
    const { resolveApiKeyRoutingContext } = await import("@/sse/services/apiKeyRouting.js");
    const context = await resolveApiKeyRoutingContext({
      apiKey: "unknown",
      requireApiKey: true,
      lookup: vi.fn().mockResolvedValue(null),
    });
    expect(context).toMatchObject({ ok: false, status: 401 });
  });

  it("maps NULL to unrestricted and an explicit list to restricted", async () => {
    const { resolveApiKeyRoutingContext } = await import("@/sse/services/apiKeyRouting.js");
    const inherited = await resolveApiKeyRoutingContext({
      apiKey: "a", requireApiKey: true,
      lookup: vi.fn().mockResolvedValue({ id: "1", name: "A", isActive: true, activeProviders: null }),
    });
    const restricted = await resolveApiKeyRoutingContext({
      apiKey: "b", requireApiKey: true,
      lookup: vi.fn().mockResolvedValue({ id: "2", name: "B", isActive: true, activeProviders: ["claude"] }),
    });
    expect(inherited.mode).toBe("unrestricted");
    expect([...restricted.activeProviders]).toEqual(["claude"]);
  });

  it("filters candidates in order without removing duplicates", async () => {
    const { filterModelCandidates } = await import("@/sse/services/apiKeyRouting.js");
    const context = { ok: true, mode: "restricted", activeProviders: new Set(["claude"]) };
    const resolveModelInfo = vi.fn(async (model) => ({
      provider: model.startsWith("cc/") ? "claude" : "codex",
      model,
    }));
    await expect(filterModelCandidates(
      ["cc/a", "cx/b", "cc/a"], context, resolveModelInfo,
    )).resolves.toEqual(["cc/a", "cc/a"]);
  });
});
```

- [ ] **Step 2: Write a failing custom error-code test**

In the same file:

```js
it("allows a route-specific error code without changing the default type", async () => {
  const { buildErrorBody } = await import("../../open-sse/utils/error.js");
  expect(buildErrorBody(403, "Provider disabled", {
    code: "provider_not_active_for_api_key",
  })).toEqual({
    error: {
      message: "Provider disabled",
      type: "permission_error",
      code: "provider_not_active_for_api_key",
    },
  });
});
```

- [ ] **Step 3: Run the policy tests and observe missing interfaces**

Run:

```bash
npm --prefix tests test -- unit/api-key-routing-policy.test.js
```

Expected: FAIL because the policy module and override argument do not exist.

- [ ] **Step 4: Implement `apiKeyRouting.js`**

Use immutable context constants for unrestricted requests and a `Set` for restricted membership:

```js
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
```

`isProviderActive` returns true in unrestricted mode and performs exact
canonical-ID membership in restricted mode. `filterModelCandidates` resolves
each candidate sequentially to preserve order and duplicates, skips models
whose provider is null/unknown, and returns a new array.

- [ ] **Step 5: Extend the error helper compatibly**

Change `buildErrorBody` and `errorResponse` to accept an optional third object.
The default two-argument behavior must remain byte-for-byte equivalent:

```js
export function buildErrorBody(statusCode, message, overrides = {}) {
  const errorInfo = ERROR_TYPES[statusCode] || (statusCode >= 500
    ? { type: "server_error", code: "internal_server_error" }
    : { type: "invalid_request_error", code: "" });
  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: overrides.type || errorInfo.type,
      code: overrides.code ?? errorInfo.code,
    },
  };
}
```

Pass `overrides` through `errorResponse`; do not alter `writeStreamError` or
existing callers.

- [ ] **Step 6: Run policy tests and existing error-sensitive tests**

Run:

```bash
npm --prefix tests test -- unit/api-key-routing-policy.test.js unit/dashboard-guard.test.js unit/local-request-peer-trust-3294.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/sse/services/apiKeyRouting.js open-sse/utils/error.js tests/unit/api-key-routing-policy.test.js
git commit -m "feat: add API-key provider routing policy"
```

---

### Task 4: Enforce the policy in direct, combo, adapter, and fusion chat routing

**Files:**
- Create: `tests/unit/api-key-chat-routing.test.js`
- Modify: `src/sse/handlers/chat.js:1-320`

**Interfaces:**
- Consumes: `resolveApiKeyRoutingContext`, `isProviderActive`, and `filterModelCandidates` from Task 3.
- Consumes: `errorResponse(status, message, { code })` from Task 3.
- Preserves: raw `apiKey` passed to `handleChatCore` for existing usage attribution.
- Changes internal signature to: `handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, routingContext)`.

- [ ] **Step 1: Write failing direct-routing tests**

Create `tests/unit/api-key-chat-routing.test.js` with hoisted mocks for settings,
model resolution, combos, credentials, `handleChatCore`, and routing context.
Use a real `Request` and import `handleChat` after mocks:

```js
it("rejects a direct inactive provider before credential selection", async () => {
  mocks.resolveContext.mockResolvedValue({
    ok: true,
    mode: "restricted",
    key: { id: "key-1", name: "Pegasus" },
    activeProviders: new Set(["claude"]),
  });
  mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });

  const response = await handleChat(chatRequest({ model: "cx/gpt-5" }));
  const body = await response.json();

  expect(response.status).toBe(403);
  expect(body.error.code).toBe("provider_not_active_for_api_key");
  expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
});

it("keeps active direct-provider dispatch unchanged", async () => {
  mocks.resolveContext.mockResolvedValue(restricted(["codex"]));
  mocks.getModelInfo.mockResolvedValue({ provider: "codex", model: "gpt-5" });
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "c1", accessToken: "token" });
  mocks.handleChatCore.mockResolvedValue(Response.json({ ok: true }));
  const response = await handleChat(chatRequest({ model: "cx/gpt-5" }));
  expect(response.status).toBe(200);
  expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Add failing combo and capacity tests**

Add cases proving:

```js
expect(await routedComboModels(["cc/a", "cx/b", "cc/c"], ["claude"]))
  .toEqual(["cc/a", "cc/c"]);
```

Assert an all-filtered combo returns code
`no_active_combo_providers_for_api_key` without calling `handleComboChat` or
`getProviderCredentials`. Assert an inactive capacity-adapter model is removed,
while the already-authorized requested direct provider remains. Assert a
configured fusion judge on an inactive provider reaches the final direct guard
and returns the direct inactive-provider 403.

- [ ] **Step 3: Run chat tests and confirm current handler ignores the policy**

Run:

```bash
npm --prefix tests test -- unit/api-key-chat-routing.test.js
```

Expected: FAIL because `handleChat` still performs boolean-only validation and
does not pass a routing context.

- [ ] **Step 4: Resolve one context at the request boundary**

After extracting the raw key and loading settings, replace the duplicated
required-key boolean block with:

```js
const routingContext = await resolveApiKeyRoutingContext({
  apiKey,
  requireApiKey: !!settings.requireApiKey,
});
if (!routingContext.ok) {
  log.warn("AUTH", routingContext.message);
  return errorResponse(routingContext.status, routingContext.message);
}
```

Pass both `apiKey` and `routingContext` to every direct, nested, combo, fusion,
and capacity-adapter callback. Keep the raw key because existing usage logging
depends on it.

- [ ] **Step 5: Centralize combo filtering inside `chat.js`**

Extract the currently duplicated top-level/nested combo setup into a local
`handleResolvedCombo` helper. It must:

1. Call `filterModelCandidates(comboModels, routingContext)` before strategy
   selection and rotation.
2. Return the stable empty-combo 403 before `augmentModelsWithCapacityAdapter`.
3. Add capacity adapters, then filter the augmented array again.
4. Preserve the existing fusion/fallback/sticky configuration and raw request
   cleanup.

Use a small error helper:

```js
function emptyComboResponse(context, comboName) {
  return errorResponse(
    HTTP_STATUS.FORBIDDEN,
    `No providers in combo "${comboName}" are active for API key "${context.key?.name || "selected key"}"`,
    { code: "no_active_combo_providers_for_api_key" },
  );
}
```

- [ ] **Step 6: Guard requested direct providers before adapters and again before credentials**

For a non-combo requested model, resolve its provider and reject an inactive
provider before capacity adaptation. Keep the same guard in
`handleSingleModelChat` immediately after `getModelInfo`; this final check
protects nested calls and fusion judges:

```js
if (!isProviderActive(routingContext, provider)) {
  return errorResponse(
    HTTP_STATUS.FORBIDDEN,
    `Provider "${provider}" is not active for API key "${routingContext.key?.name || "selected key"}"`,
    { code: "provider_not_active_for_api_key" },
  );
}
```

- [ ] **Step 7: Run chat and combo regression tests**

Run:

```bash
npm --prefix tests test -- unit/api-key-chat-routing.test.js unit/combo-routing.test.js unit/combo-fusion.test.js unit/combo-autoswitch.test.js unit/gemini-native-endpoint.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/sse/handlers/chat.js tests/unit/api-key-chat-routing.test.js
git commit -m "feat: enforce provider routing for API keys"
```

---

### Task 5: Filter `/v1/models` with the same routing context

**Files:**
- Create: `tests/unit/api-key-model-list.test.js`
- Modify: `src/app/api/v1/models/route.js:1-580`

**Interfaces:**
- Consumes: `extractApiKey(request)` and `getSettings()`.
- Consumes: `resolveApiKeyRoutingContext`, `isProviderActive`, and `filterModelCandidates` from Task 3.
- Extends: `buildModelsList(kindFilter, { skipDynamicFetch, routingContext })`.

- [ ] **Step 1: Write failing model-list tests**

Mock `getProviderConnections`, `getCombos`, aliases/custom models, settings,
and routing context, then import `buildModelsList`/`GET`:

```js
it("lists only direct models owned by active providers", async () => {
  mocks.getProviderConnections.mockResolvedValue([
    { id: "c1", provider: "claude", isActive: true },
    { id: "c2", provider: "codex", isActive: true },
  ]);
  const data = await buildModelsList(["llm"], {
    routingContext: restricted(["claude"]),
    skipDynamicFetch: true,
  });
  expect(data.some((m) => m.owned_by === "cc")).toBe(true);
  expect(data.some((m) => m.owned_by === "cx")).toBe(false);
});

it("keeps only combos with at least one active candidate", async () => {
  mocks.getCombos.mockResolvedValue([
    { name: "usable", models: ["cc/a", "cx/b"] },
    { name: "blocked", models: ["cx/b"] },
  ]);
  const data = await buildModelsList(["llm"], {
    routingContext: restricted(["claude"]),
    skipDynamicFetch: true,
  });
  expect(data.map((m) => m.id)).toContain("usable");
  expect(data.map((m) => m.id)).not.toContain("blocked");
});
```

Add GET tests proving an unrestricted context returns the current list and a
required invalid key returns the existing 401 envelope.

- [ ] **Step 2: Run the focused model-list test and observe unfiltered results**

Run:

```bash
npm --prefix tests test -- unit/api-key-model-list.test.js
```

Expected: FAIL because `buildModelsList` ignores `routingContext`.

- [ ] **Step 3: Filter combos and provider loops**

Default a missing context to unrestricted so `/v1/models/[kind]` callers keep
their current behavior. Before pushing a combo entry, call
`filterModelCandidates(combo.models, routingContext)` and skip a restricted
combo whose result is empty.

Before emitting static models or entering a connected-provider model loop,
check the canonical provider ID:

```js
if (!isProviderActive(routingContext, providerId)) continue;
```

Do not filter Media Provider kinds in `/v1/models/[kind]`; only the default LLM
GET passes a key-derived routing context.

- [ ] **Step 4: Resolve the context in `GET /v1/models`**

Extract the key, load settings, resolve the context, return existing 401 errors
when `context.ok` is false, and pass the context into `buildModelsList`:

```js
const apiKey = extractApiKey(request);
const settings = await getSettings();
const routingContext = await resolveApiKeyRoutingContext({
  apiKey,
  requireApiKey: !!settings.requireApiKey,
});
if (!routingContext.ok) return errorResponse(routingContext.status, routingContext.message);
```

- [ ] **Step 5: Run focused and existing model-list tests**

Run:

```bash
npm --prefix tests test -- unit/api-key-model-list.test.js unit/provider-custom-models.test.js unit/cursor-models.test.js unit/opencode-go-models.test.js unit/grok-cli-models.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/app/api/v1/models/route.js tests/unit/api-key-model-list.test.js
git commit -m "feat: filter models by API-key providers"
```

---

### Task 6: Add the Global/API-key dashboard view and autosave routing toggles

**Files:**
- Create: `src/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js`
- Create: `src/app/(dashboard)/dashboard/providers/components/ProviderRoutingContextBar.js`
- Create: `tests/unit/api-key-provider-ui-state.test.js`
- Modify: `src/app/(dashboard)/dashboard/providers/page.js:1-910`

**Interfaces:**
- Produces: `GLOBAL_PROVIDER_VIEW = "global"`.
- Produces: `materializeActiveProviders(apiKey, catalogIds): string[]`.
- Produces: `nextActiveProviders(apiKey, catalogIds, providerId, nextActive): string[]`.
- Produces: `saveActiveProviders(keyId, activeProviders, fetchImpl = fetch): Promise<ApiKey>`.
- Produces: `ProviderRoutingContextBar({ apiKeys, selectedView, onChange, activeCount, totalCount })`.

- [ ] **Step 1: Write failing pure UI-state tests**

Create `tests/unit/api-key-provider-ui-state.test.js`:

```js
import { describe, expect, it, vi } from "vitest";

describe("API-key provider dashboard state", () => {
  it("materializes all current IDs for an inherited key", async () => {
    const { materializeActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    expect(materializeActiveProviders(
      { activeProviders: null }, ["claude", "codex"],
    )).toEqual(["claude", "codex"]);
  });

  it("turns one provider off without reordering the others", async () => {
    const { nextActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    expect(nextActiveProviders(
      { activeProviders: null }, ["claude", "codex"], "codex", false,
    )).toEqual(["claude"]);
  });

  it("rejects turning off the final active provider", async () => {
    const { nextActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    expect(() => nextActiveProviders(
      { activeProviders: ["claude"] }, ["claude", "codex"], "claude", false,
    )).toThrowError(/at least one provider/i);
  });

  it("recovers a stale explicit list when every stored provider was removed", async () => {
    const { materializeActiveProviders, nextActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const staleKey = { activeProviders: ["removed-provider"] };
    expect(materializeActiveProviders(staleKey, ["claude"])).toEqual([]);
    expect(nextActiveProviders(
      staleKey, ["claude"], "claude", true,
    )).toEqual(["claude"]);
  });

  it("returns normalized server state and throws on failed autosave", async () => {
    const { saveActiveProviders } = await import(
      "@/app/(dashboard)/dashboard/providers/apiKeyRoutingState.js"
    );
    const okFetch = vi.fn().mockResolvedValue(Response.json({
      key: { id: "k1", activeProviders: ["claude"] },
    }));
    await expect(saveActiveProviders("k1", ["claude"], okFetch))
      .resolves.toMatchObject({ activeProviders: ["claude"] });

    const badFetch = vi.fn().mockResolvedValue(Response.json(
      { error: { message: "Save failed" } }, { status: 500 },
    ));
    await expect(saveActiveProviders("k1", ["claude"], badFetch))
      .rejects.toThrow("Save failed");
  });
});
```

- [ ] **Step 2: Run the UI-state tests and observe the missing module**

Run:

```bash
npm --prefix tests test -- unit/api-key-provider-ui-state.test.js
```

Expected: FAIL because the state module does not exist.

- [ ] **Step 3: Implement pure state and save helpers**

Keep state transitions independent of React. Intersect explicit arrays with the
current catalog, preserve catalog order for inherited keys, append a newly
enabled current provider once, and throw a named `ProviderSelectionError` when
the result would be empty.

`saveActiveProviders` must issue exactly:

```js
const response = await fetchImpl(`/api/keys/${keyId}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ activeProviders }),
});
```

Parse the response once, throw the server's message on failure, and return
`payload.key` on success.

- [ ] **Step 4: Implement the context bar component**

Render a native/select-styled control whose first option is Global connections
and whose remaining options show key name, masked suffix, and disabled state.
Only show `N of M active` in key mode. Required accessible copy:

```jsx
<label htmlFor="provider-routing-view">View</label>
<select
  id="provider-routing-view"
  value={selectedView}
  onChange={(event) => onChange(event.target.value)}
>
  <option value={GLOBAL_PROVIDER_VIEW}>Global connections</option>
  {apiKeys.map((key) => (
    <option key={key.id} value={key.id}>
      {key.name || "Unnamed key"} · {maskKey(key.key)}{key.isActive ? "" : " · Disabled"}
    </option>
  ))}
</select>
```

- [ ] **Step 5: Integrate key loading and full-catalog derivation into the page**

Fetch `/api/keys` beside the existing providers and provider-nodes requests.
Initialize `selectedView` to `GLOBAL_PROVIDER_VIEW` on every mount. Derive the
full routable catalog before search and `Show all` pagination from the same
built-in LLM entries and compatible nodes rendered by the page.

Do not derive the `N of M` count from `visibleApikeyEntries`; search and
pagination must not alter it.

- [ ] **Step 6: Add optimistic autosave with rollback**

In key mode, compute `nextProviders`, snapshot the prior `apiKeys` state, apply
the optimistic array to the selected key, and call `saveActiveProviders`.
Replace the optimistic key with the normalized server response on success. On
failure, restore the snapshot and call `notify.error(error.message)`. When the
last-provider guard throws, do not issue a request; show a warning directing
the operator to disable the API key instead.

- [ ] **Step 7: Give card toggles one meaning at a time**

Extend both local card components with:

```js
keyRoutingMode: PropTypes.bool,
keyActive: PropTypes.bool,
onKeyToggle: PropTypes.func,
```

In Global mode, retain the existing hover toggle, `stats.total > 0` condition,
and `handleToggleProvider` callback unchanged. In API-key mode, render an
always-visible toggle even when the provider has no connection, label it
`Active for selected API key`, and call `onKeyToggle` after preventing link
navigation. Connection badges remain global and unchanged.

Only routable LLM cards receive key-mode controls; Media-only provider behavior
stays global.

- [ ] **Step 8: Run UI-state tests and a production build**

Run:

```bash
npm --prefix tests test -- unit/api-key-provider-ui-state.test.js
npm run build
```

Expected: focused tests PASS and Next.js production build succeeds without
PropTypes, import, hydration, or lint errors.

- [ ] **Step 9: Perform a browser smoke test on the isolated dev data**

Start the clone's existing dev server (`DATA_DIR=.dev-data`, port 20127), then
open `http://localhost:20127/dashboard/providers` and verify:

1. Page opens in Global connections mode and the old connection toggle works.
2. Selecting two different API keys shows independent provider states.
3. A key with `activeProviders: null` initially shows every current LLM provider active.
4. One toggle saves immediately and survives reload.
5. A provider with no connection can be active for the key while still showing `No connections`.
6. The final active provider cannot be switched off.
7. Search and `Show all` do not change the toolbar count.

- [ ] **Step 10: Commit Task 6**

```bash
git add src/app/'(dashboard)'/dashboard/providers/apiKeyRoutingState.js src/app/'(dashboard)'/dashboard/providers/components/ProviderRoutingContextBar.js src/app/'(dashboard)'/dashboard/providers/page.js tests/unit/api-key-provider-ui-state.test.js
git commit -m "feat: manage providers per API key in dashboard"
```

---

### Task 7: Verify migration, routing compatibility, and release readiness

**Files:**
- Verify only: all files changed in Tasks 1-6
- Update only if behavior changed during implementation: `docs/superpowers/specs/2026-08-24-api-key-provider-routing-design.md`

**Interfaces:**
- Consumes every interface defined in Tasks 1-6.
- Produces a tested `custom/pegasus` branch; it does not replace the globally installed npm package or restart the public server without a separate rollout confirmation.

- [ ] **Step 1: Run every new focused suite together**

```bash
npm --prefix tests test -- \
  unit/api-key-provider-db.test.js \
  unit/api-key-provider-catalog.test.js \
  unit/api-key-routing-policy.test.js \
  unit/api-key-chat-routing.test.js \
  unit/api-key-model-list.test.js \
  unit/api-key-provider-ui-state.test.js
```

Expected: PASS with no skipped new tests.

- [ ] **Step 2: Run affected regression suites**

```bash
npm --prefix tests test -- \
  unit/db-migration-chain.test.js \
  unit/db-sqlite-vs-lowdb.test.js \
  unit/dashboard-guard.test.js \
  unit/local-request-peer-trust-3294.test.js \
  unit/combo-routing.test.js \
  unit/combo-fusion.test.js \
  unit/combo-autoswitch.test.js \
  unit/gemini-native-endpoint.test.js \
  unit/provider-custom-models.test.js
```

Expected: PASS.

- [ ] **Step 3: Run the full suite and compare with the pre-change baseline**

```bash
npm --prefix tests test
```

Expected: no new failing test files or assertions relative to the pristine
`v0.5.55` baseline. Record any upstream baseline failures separately from this
feature's focused green suites.

- [ ] **Step 4: Run final build and whitespace checks**

```bash
git diff --check origin/custom/pegasus...HEAD
npm run build
```

Expected: no whitespace errors and production build succeeds.

- [ ] **Step 5: Exercise two-key routing through the dev server**

Using `.dev-data`, create or select two active endpoint keys:

- Key A: `claude` active and `codex` inactive.
- Key B: `codex` active and `claude` inactive.

Verify with the same direct and combo model names:

1. Key A receives a 403 with `provider_not_active_for_api_key` for a Codex direct model.
2. Key B receives the corresponding 403 for a Claude direct model.
3. The same combo routes through different remaining provider candidates for each key.
4. `/v1/models` omits direct models and all-blocked combos for each key.
5. A legacy/`NULL` key still sees and routes all current providers.

- [ ] **Step 6: Review the final diff against the spec**

Confirm every acceptance criterion in the spec has test or smoke evidence,
confirm no Media Provider handler changed, and confirm the global npm-installed
9router plus `com.9router.localserver.session` remain untouched.

If verification uncovers a correction, return to the owning task's
failing-test → minimal-fix → focused-test → commit cycle, then repeat Task 7
from Step 1. Do not create an empty verification-only commit.
