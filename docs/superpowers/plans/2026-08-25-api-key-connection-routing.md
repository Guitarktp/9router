# API-Key-Specific Provider Connection Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each endpoint API key inherit or explicitly select a non-empty subset of globally active connections within each active LLM provider.

**Architecture:** Store a nullable provider-to-connection allowlist on each API-key row, validate it at the API boundary, carry it in the existing request routing context, and filter credential candidates before rotation and retry. Preserve the selected API-key context in the Providers URL and render provider details either as global management or key-specific selection.

**Tech Stack:** Next.js 16 App Router, React 19, JavaScript, SQLite through the existing adapter, Vitest, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-08-25-api-key-connection-routing-design.md`

## Global Constraints

- Existing and new keys default to inherited global connections.
- Global `providerConnections.isActive` is the master switch; key policy only narrows it.
- A customized provider retains at least one selected connection.
- Missing/stale IDs fail closed and never trigger implicit inheritance.
- `activeProviders` remains the outer policy; connection policy is inert while its provider is inactive.
- Priority, sticky, rotation, retry, quota, cooldown, proxy, token refresh, and health stay unchanged after filtering.
- No-auth virtual connections and Media Providers stay unchanged.
- Add no runtime dependency and never include the runtime-generated `CLAUDE.md` change in feature commits.

## File Map

- Persistence: `src/lib/db/schema.js`, `src/lib/db/repos/apiKeysRepo.js`, `src/lib/db/index.js`, `src/lib/db/migrate.js`
- Validation/API: `src/lib/apiKeyConnectionPolicy.js`, `src/app/api/keys/route.js`, `src/app/api/keys/[id]/route.js`
- Runtime: `src/sse/services/apiKeyRouting.js`, `src/sse/services/auth.js`, `src/sse/handlers/chat.js`
- UI state/navigation: `src/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js`, `providerViewContext.js`, `page.js`
- Detail UI: `src/app/(dashboard)/dashboard/providers/[id]/page.js`, `ConnectionRow.js`
- Tests: existing API-key provider tests plus new connection API/auth tests.

---

### Task 1: Persist API-Key Connection Policies

**Files:**
- Modify: `src/lib/db/schema.js`
- Modify: `src/lib/db/repos/apiKeysRepo.js`
- Modify: `src/lib/db/index.js`
- Modify: `src/lib/db/migrate.js`
- Test: `tests/unit/api-key-provider-db.test.js`

**Interfaces:**
- Produces: `parseActiveConnections(value) -> null | Record<string, string[]>`
- Produces: API-key records with `activeConnections: null | Record<string, string[]>`.

- [ ] **Step 1: Write failing persistence tests**

```js
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
```

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/api-key-provider-db.test.js`

Expected: missing property/column failures.

- [ ] **Step 3: Implement schema and repository serialization**

Set `SCHEMA_VERSION = 3`; add `activeConnections: "TEXT"` to `apiKeys`; add this parser and use it from `rowToKey`:

```js
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
```

Default new keys to `null`. Include `activeConnections` in every API-key INSERT/UPDATE and serialize non-null objects with `stringifyJson`.

- [ ] **Step 4: Extend current and legacy import**

In both import paths parse the field, then use this eight-column statement:

```sql
INSERT OR REPLACE INTO apiKeys(
  id, key, name, machineId, isActive, activeProviders, activeConnections, createdAt
) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
```

- [ ] **Step 5: Verify persistence and commit**

Run: `npx vitest run tests/unit/api-key-provider-db.test.js`

Expected: PASS.

```bash
git add src/lib/db/schema.js src/lib/db/repos/apiKeysRepo.js src/lib/db/index.js src/lib/db/migrate.js tests/unit/api-key-provider-db.test.js
git commit -m "feat: persist API key connection policies"
```

---

### Task 2: Validate and Expose Policies Through the Key API

**Files:**
- Create: `src/lib/apiKeyConnectionPolicy.js`
- Modify: `src/app/api/keys/route.js`
- Modify: `src/app/api/keys/[id]/route.js`
- Create: `tests/unit/api-key-connection-api.test.js`

**Interfaces:**
- Produces: `normalizeActiveConnectionInput(value, previousValue, deps?)`
- Produces: `intersectApiKeysWithCurrentConnections(keys, deps?)`
- Produces: `ActiveConnectionValidationError { code, status: 400 }`.

- [ ] **Step 1: Write failing validation tests**

```js
const deps = {
  getProviderIds: async () => ["claude", "codex"],
  getConnections: async () => [
    { id: "claude-1", provider: "claude", isActive: true },
    { id: "claude-2", provider: "claude", isActive: false },
    { id: "codex-1", provider: "codex", isActive: true },
  ],
};

it("accepts a non-empty mapping", async () => {
  const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
  await expect(normalizeActiveConnectionInput(
    { claude: ["claude-1"] }, null, deps,
  )).resolves.toEqual({ claude: ["claude-1"] });
});

it("rejects a newly selected globally inactive connection", async () => {
  const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
  await expect(normalizeActiveConnectionInput(
    { claude: ["claude-2"] }, null, deps,
  )).rejects.toMatchObject({ code: "connection_globally_inactive" });
});

it("retains a prior selection after global disable", async () => {
  const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
  await expect(normalizeActiveConnectionInput(
    { claude: ["claude-2"] }, { claude: ["claude-2"] }, deps,
  )).resolves.toEqual({ claude: ["claude-2"] });
});
```

Add the remaining validation cases with this table and explicit stale-read assertion:

```js
it.each([
  [{ claude: [] }, "at_least_one_connection_required"],
  [{ claude: ["claude-1", "claude-1"] }, "invalid_active_connections"],
  [{ missing: ["claude-1"] }, "invalid_active_connections"],
  [{ claude: ["codex-1"] }, "invalid_active_connections"],
])("rejects invalid policy %j", async (value, code) => {
  const { normalizeActiveConnectionInput } = await import("@/lib/apiKeyConnectionPolicy.js");
  await expect(normalizeActiveConnectionInput(value, null, deps))
    .rejects.toMatchObject({ code });
});

it("filters stale IDs without restoring inheritance", async () => {
  const { intersectApiKeysWithCurrentConnections } = await import("@/lib/apiKeyConnectionPolicy.js");
  const [key] = await intersectApiKeysWithCurrentConnections([
    { id: "key-1", activeConnections: { claude: ["deleted"] } },
  ], deps);
  expect(key.activeConnections).toEqual({ claude: [] });
});
```

- [ ] **Step 2: Verify validation tests fail**

Run: `npx vitest run tests/unit/api-key-connection-api.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the validator**

```js
export class ActiveConnectionValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ActiveConnectionValidationError";
    this.code = code;
    this.status = 400;
  }
}
```

`normalizeActiveConnectionInput` must: accept `null`; reject non-plain objects; canonicalize provider aliases; validate providers against `getRoutableProviderIds`; reject empty/duplicate ID arrays; load all connections; verify existence/provider ownership; reject an inactive ID unless the same ID existed in `previousValue`; return `null` for `{}`.

`intersectApiKeysWithCurrentConnections` must remove stale/mismatched IDs but preserve an empty array for a provider that had an explicit stale policy, preventing accidental inheritance.

- [ ] **Step 4: Wire GET and PUT routes**

Run connection intersection after provider intersection on both GET routes. In PUT:

```js
if (Object.hasOwn(body, "activeConnections")) {
  updateData.activeConnections = await normalizeActiveConnectionInput(
    body.activeConnections,
    existing.activeConnections,
  );
}
```

Catch `ActiveConnectionValidationError` and return `{ error: { code, message } }` with status 400 without calling `updateApiKey`.

- [ ] **Step 5: Verify API behavior and commit**

Run: `npx vitest run tests/unit/api-key-connection-api.test.js tests/unit/api-key-provider-catalog.test.js`

Expected: PASS, including existing provider updates.

```bash
git add src/lib/apiKeyConnectionPolicy.js src/app/api/keys/route.js 'src/app/api/keys/[id]/route.js' tests/unit/api-key-connection-api.test.js
git commit -m "feat: validate API key connection policies"
```

---

### Task 3: Filter Credential Selection by the Request Policy

**Files:**
- Modify: `src/sse/services/apiKeyRouting.js`
- Modify: `src/sse/services/auth.js`
- Modify: `tests/unit/api-key-routing-policy.test.js`
- Create: `tests/unit/api-key-connection-auth.test.js`

**Interfaces:**
- Produces: `getAllowedConnectionIds(context, providerId) -> null | Set<string>`
- Extends: `getProviderCredentials(provider, excluded, model, { preferredConnectionId?, allowedConnectionIds? })`.

- [ ] **Step 1: Write failing context and auth tests**

```js
it("returns a provider-specific allowlist", async () => {
  const { resolveApiKeyRoutingContext, getAllowedConnectionIds } = await import(
    "@/sse/services/apiKeyRouting.js"
  );
  const context = await resolveApiKeyRoutingContext({
    apiKey: "key-a",
    requireApiKey: true,
    lookup: vi.fn().mockResolvedValue({
      id: "key-a",
      isActive: true,
      activeProviders: null,
      activeConnections: { claude: ["claude-1", "claude-3"] },
    }),
  });
  expect([...getAllowedConnectionIds(context, "cc")]).toEqual([
    "claude-1",
    "claude-3",
  ]);
  expect(getAllowedConnectionIds(context, "codex")).toBeNull();
});

it("filters globally active connections before selection", async () => {
  mocks.getProviderConnections.mockResolvedValue([
    { id: "claude-1", provider: "claude", isActive: true, priority: 1 },
    { id: "claude-2", provider: "claude", isActive: true, priority: 2 },
  ]);
  const { getProviderCredentials } = await import("@/sse/services/auth.js");
  const result = await getProviderCredentials("claude", null, "opus", {
    allowedConnectionIds: new Set(["claude-2"]),
  });
  expect(result.connectionId).toBe("claude-2");
});
```

Add explicit assertions for boundary behavior:

```js
const emptyResult = await getProviderCredentials("claude", null, "opus", {
  allowedConnectionIds: new Set(),
});
expect(emptyResult).toBeNull();

const preferredResult = await getProviderCredentials("claude", null, "opus", {
  preferredConnectionId: "claude-1",
  allowedConnectionIds: new Set(["claude-2"]),
});
expect(preferredResult.connectionId).toBe("claude-2");

const inheritedResult = await getProviderCredentials("claude", null, "opus");
expect(inheritedResult.connectionId).toBe("claude-1");
```

For the no-auth fixture, assert the returned virtual connection ID is `noauth` and `getProviderConnections` was not called.

- [ ] **Step 2: Verify focused tests fail**

Run: `npx vitest run tests/unit/api-key-routing-policy.test.js tests/unit/api-key-connection-auth.test.js`

Expected: missing helper and unfiltered credentials.

- [ ] **Step 3: Extend the request context**

Attach the recognized key's connection policy even when provider mode is unrestricted:

```js
const baseContext = {
  ok: true,
  key,
  activeConnections: key.activeConnections || null,
};

if (key.activeProviders === null) {
  return { ...baseContext, mode: ROUTING_MODE.UNRESTRICTED };
}
```

Add:

```js
export function getAllowedConnectionIds(context, providerId) {
  const canonicalId = resolveProviderId(providerId);
  const configured = context?.activeConnections?.[canonicalId];
  return Array.isArray(configured) ? new Set(configured) : null;
}
```

- [ ] **Step 4: Filter before exclusions, locks, preferred selection, and rotation**

Keep the no-auth early return unchanged. For stored connections:

```js
const allowedConnectionIds = options?.allowedConnectionIds instanceof Set
  ? options.allowedConnectionIds
  : null;
const globalConnections = await getProviderConnections({
  provider: providerId,
  isActive: true,
});
const connections = allowedConnectionIds === null
  ? globalConnections
  : globalConnections.filter((connection) => allowedConnectionIds.has(connection.id));
```

All existing logic below operates only on `connections`.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/api-key-routing-policy.test.js tests/unit/api-key-connection-auth.test.js`

Expected: PASS.

```bash
git add src/sse/services/apiKeyRouting.js src/sse/services/auth.js tests/unit/api-key-routing-policy.test.js tests/unit/api-key-connection-auth.test.js
git commit -m "feat: filter credentials by API key connection policy"
```

---

### Task 4: Keep the Same Allowlist Across Direct, Combo, and Retry Routing

**Files:**
- Modify: `src/sse/handlers/chat.js`
- Modify: `tests/unit/api-key-chat-routing.test.js`
- Modify: `tests/unit/api-key-gemini-routing.test.js`

**Interfaces:**
- Consumes: `getAllowedConnectionIds(context, providerId)` from Task 3.
- Produces: every credential attempt for one provider receives the same set.

- [ ] **Step 1: Write failing direct/retry tests**

```js
it("uses the selected subset on every retry", async () => {
  mocks.resolveContext.mockResolvedValue({
    ...restricted(["claude"]),
    activeConnections: { claude: ["claude-2", "claude-4"] },
  });
  mocks.getModelInfo.mockResolvedValue({ provider: "claude", model: "opus" });
  mocks.getProviderCredentials
    .mockResolvedValueOnce({ connectionId: "claude-2", connectionName: "Two", accessToken: "t2" })
    .mockResolvedValueOnce({ connectionId: "claude-4", connectionName: "Four", accessToken: "t4" });
  mocks.handleChatCore
    .mockResolvedValueOnce({ success: false, status: 429, error: "limited" })
    .mockResolvedValueOnce({ success: true, response: Response.json({ ok: true }) });

  const response = await handleChat(chatRequest({ model: "cc/opus" }));
  expect(response.status).toBe(200);
  for (const call of mocks.getProviderCredentials.mock.calls) {
    expect([...call[3].allowedConnectionIds]).toEqual(["claude-2", "claude-4"]);
  }
});
```

Add a combo assertion that credential calls for Claude receive `new Set(["claude-2"])` while Codex calls receive `new Set(["codex-7"])`. Invoke the same direct model twice with contexts for Key A and Key B and assert their fourth arguments contain disjoint Claude sets.

- [ ] **Step 2: Verify chat tests fail**

Run: `npx vitest run tests/unit/api-key-chat-routing.test.js tests/unit/api-key-gemini-routing.test.js`

Expected: credential calls lack an options allowlist.

- [ ] **Step 3: Pass one provider set through the retry loop**

Import `getAllowedConnectionIds`; compute it outside the loop:

```js
const allowedConnectionIds = getAllowedConnectionIds(routingContext, provider);

while (true) {
  const credentials = await getProviderCredentials(
    provider,
    excludeConnectionIds,
    model,
    { allowedConnectionIds },
  );
```

Combo and fusion already call `handleSingleModelChat` with the same context, so do not change their ordering or rotation state.

- [ ] **Step 4: Cover the Gemini-compatible converted chat path**

Give the recognized fixture `activeConnections: { codex: ["codex-2"] }`, allow Codex in `activeProviders`, call non-native `/v1beta`, and assert:

```js
expect(mocks.getProviderCredentials).toHaveBeenCalledWith(
  "codex",
  expect.any(Set),
  "gpt-5",
  expect.objectContaining({
    allowedConnectionIds: new Set(["codex-2"]),
  }),
);
```

Leave native Gemini TTS unchanged because it is outside the main LLM routing scope.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/api-key-chat-routing.test.js tests/unit/api-key-gemini-routing.test.js tests/unit/combo-routing.test.js`

Expected: PASS; retries and combo fallback stay within policy.

```bash
git add src/sse/handlers/chat.js tests/unit/api-key-chat-routing.test.js tests/unit/api-key-gemini-routing.test.js
git commit -m "feat: enforce connection policies during chat routing"
```

---

### Task 5: Add Pure Dashboard State and URL Helpers

**Files:**
- Create: `src/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js`
- Create: `src/app/(dashboard)/dashboard/providers/providerViewContext.js`
- Modify: `tests/unit/api-key-provider-ui-state.test.js`

**Interfaces:**
- Produces: `getProviderConnectionMode`, `materializeConnectionSelection`, `effectiveConnectionIds`, `setProviderConnectionMode`, `nextActiveConnections`.
- Produces: `saveActiveConnections` and `createActiveConnectionSaveCoordinator`.
- Produces: `buildProviderDetailHref` and `resolveProviderView`.

- [ ] **Step 1: Write failing state tests**

```js
it("materializes only globally active rows for inherited mode", async () => {
  const { materializeConnectionSelection } = await import(
    "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
  );
  expect(materializeConnectionSelection(
    { activeConnections: null },
    "claude",
    [{ id: "c1", isActive: true }, { id: "c2", isActive: false }],
  )).toEqual(["c1"]);
});

it("rejects deselecting the final custom connection", async () => {
  const { nextActiveConnections } = await import(
    "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
  );
  expect(() => nextActiveConnections(
    { activeConnections: { claude: ["c1"] } },
    "claude",
    "c1",
    false,
    [{ id: "c1", isActive: true }],
  )).toThrowError(/at least one connection/i);
});

it("preserves API key context in detail links", async () => {
  const { buildProviderDetailHref } = await import(
    "@/app/(dashboard)/dashboard/providers/providerViewContext.js"
  );
  expect(buildProviderDetailHref("claude", "key/a"))
    .toBe("/dashboard/providers/claude?view=key%2Fa");
});
```

Add these transition assertions:

```js
const connections = [
  { id: "c1", isActive: true },
  { id: "c2", isActive: false },
];
expect(setProviderConnectionMode(
  { activeConnections: null }, "claude", "custom", connections,
)).toEqual({ claude: ["c1"] });
expect(setProviderConnectionMode(
  { activeConnections: { claude: ["c1"] } }, "claude", "inherit", connections,
)).toBeNull();
expect(() => nextActiveConnections(
  { activeConnections: { claude: ["c1"] } }, "claude", "c2", true, connections,
)).toThrowError(/globally disabled/i);
expect(effectiveConnectionIds(
  { activeConnections: { claude: ["c1", "c2"] } }, "claude", connections,
)).toEqual(["c1"]);
```

Reuse the existing `deferred()` helper in two tests: a rejected newest save must restore the last confirmed key, and an older success must return `{ status: "stale" }` without overwriting a newer optimistic value.

- [ ] **Step 2: Verify state tests fail**

Run: `npx vitest run tests/unit/api-key-provider-ui-state.test.js`

Expected: missing modules.

- [ ] **Step 3: Implement immutable state transitions**

```js
export class ConnectionSelectionError extends Error {
  constructor(message = "At least one connection must remain active") {
    super(message);
    this.name = "ConnectionSelectionError";
  }
}

export function getProviderConnectionMode(apiKey, providerId) {
  return Array.isArray(apiKey?.activeConnections?.[providerId]) ? "custom" : "inherit";
}

export function materializeConnectionSelection(apiKey, providerId, connections) {
  const configured = apiKey?.activeConnections?.[providerId];
  if (Array.isArray(configured)) return [...configured];
  return connections.filter((connection) => connection.isActive !== false)
    .map((connection) => connection.id);
}
```

Custom mode snapshots globally active IDs and throws if none exist. Inherit mode removes the provider property and returns `null` if the object becomes empty. `nextActiveConnections` refuses globally inactive additions and an empty custom list. `effectiveConnectionIds` intersects selected IDs with active rows.

- [ ] **Step 4: Implement autosave and URL helpers**

```js
export async function saveActiveConnections(keyId, activeConnections, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/keys/${keyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activeConnections }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || "Save failed");
  return payload.key;
}

export function buildProviderDetailHref(providerId, selectedView) {
  const base = `/dashboard/providers/${encodeURIComponent(providerId)}`;
  return selectedView === "global" ? base : `${base}?view=${encodeURIComponent(selectedView)}`;
}

export function resolveProviderView(rawView, apiKeys) {
  return apiKeys.some((key) => key.id === rawView) ? rawView : "global";
}
```

Copy the existing versioned, per-key queue semantics into `createActiveConnectionSaveCoordinator`, changing only the payload field.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run tests/unit/api-key-provider-ui-state.test.js`

Expected: PASS, including existing provider-state tests.

```bash
git add 'src/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js' 'src/app/(dashboard)/dashboard/providers/providerViewContext.js' tests/unit/api-key-provider-ui-state.test.js
git commit -m "feat: add API key connection dashboard state"
```

---

### Task 6: Preserve Key Context Between Provider Grid and Detail

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/page.js`
- Test: `tests/unit/api-key-provider-ui-state.test.js`

**Interfaces:**
- Consumes: `buildProviderDetailHref` and `resolveProviderView` from Task 5.
- Produces: `?view=<key-id>` on grid state and provider links.

- [ ] **Step 1: Add URL reconciliation coverage**

```js
it("falls back to global when a URL key is missing", async () => {
  const { resolveProviderView } = await import(
    "@/app/(dashboard)/dashboard/providers/providerViewContext.js"
  );
  expect(resolveProviderView("missing", [{ id: "key-1" }])).toBe("global");
  expect(resolveProviderView("key-1", [{ id: "key-1" }])).toBe("key-1");
});
```

- [ ] **Step 2: Integrate URL-backed grid selection**

Import `useRouter` and `useSearchParams`. Reconcile after keys load and replace the URL without scrolling:

```js
const requestedView = searchParams.get("view") || GLOBAL_PROVIDER_VIEW;

useEffect(() => {
  if (loading) return;
  setSelectedView(resolveProviderView(requestedView, apiKeys));
}, [apiKeys, loading, requestedView]);

const handleSelectedViewChange = (nextView) => {
  setSelectedView(nextView);
  const href = nextView === GLOBAL_PROVIDER_VIEW
    ? "/dashboard/providers"
    : `/dashboard/providers?view=${encodeURIComponent(nextView)}`;
  router.replace(href, { scroll: false });
};
```

- [ ] **Step 3: Preserve context in both card variants**

Add `detailHref` to `ProviderCard` and `ApiKeyProviderCard`; replace hard-coded links:

```jsx
<Link href={detailHref} className="group min-w-0">
```

Every card call passes `buildProviderDetailHref(providerId, selectedView)`. Keep toggle click propagation behavior unchanged.

- [ ] **Step 4: Verify lint and commit**

Run:

```bash
npx vitest run tests/unit/api-key-provider-ui-state.test.js
npx eslint 'src/app/(dashboard)/dashboard/providers/page.js'
```

Expected: PASS with no lint errors.

```bash
git add 'src/app/(dashboard)/dashboard/providers/page.js' tests/unit/api-key-provider-ui-state.test.js
git commit -m "feat: preserve API key provider view in navigation"
```

---

### Task 7: Render Per-Key Connection Controls in Provider Detail

**Files:**
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`
- Test: `tests/unit/api-key-provider-ui-state.test.js`

**Interfaces:**
- Consumes: Task 5 helpers and API key `activeConnections`.
- Extends `ConnectionRow`: `viewMode`, `keySelected`, `onToggleKeySelected`.

- [ ] **Step 1: Test disabled saved-selection recovery state**

```js
it("keeps a disabled saved selection without making it effective", async () => {
  const { materializeConnectionSelection, effectiveConnectionIds } = await import(
    "@/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js"
  );
  const key = { activeConnections: { claude: ["c1"] } };
  const connections = [{ id: "c1", isActive: false }];
  expect(materializeConnectionSelection(key, "claude", connections)).toEqual(["c1"]);
  expect(effectiveConnectionIds(key, "claude", connections)).toEqual([]);
});
```

- [ ] **Step 2: Load key context in provider detail**

Add `/api/keys` to the existing parallel fetch, parse `useSearchParams().get("view")`, and derive:

```js
const selectedApiKey = selectedView === GLOBAL_PROVIDER_VIEW
  ? null
  : apiKeys.find((key) => key.id === selectedView) || null;
const connectionMode = selectedApiKey
  ? getProviderConnectionMode(selectedApiKey, providerId)
  : "inherit";
const selectedKeyConnectionIds = selectedApiKey
  ? materializeConnectionSelection(selectedApiKey, providerId, connections)
  : [];
const effectiveKeyConnectionIds = selectedApiKey
  ? effectiveConnectionIds(selectedApiKey, providerId, connections)
  : [];
const providerActiveForKey = selectedApiKey?.activeProviders === null
  || selectedApiKey?.activeProviders?.includes(providerId);
```

Create one save-coordinator ref. Mode/toggle handlers optimistically update only the selected key; `ConnectionSelectionError` produces a warning; save failure rolls back and produces an error.

Changing the context selector updates the detail URL without losing the provider:

```js
const handleSelectedViewChange = (nextView) => {
  setSelectedView(nextView);
  router.replace(buildProviderDetailHref(providerId, nextView), { scroll: false });
};
```

- [ ] **Step 3: Render context, mode, and recovery banners**

Reuse `ProviderRoutingContextBar` above Connections. In key view render:

```jsx
<div className="flex flex-wrap items-center gap-2">
  <Button
    size="sm"
    variant={connectionMode === "inherit" ? "primary" : "secondary"}
    onClick={() => handleConnectionModeChange("inherit")}
  >
    Use Global
  </Button>
  <Button
    size="sm"
    variant={connectionMode === "custom" ? "primary" : "secondary"}
    onClick={() => handleConnectionModeChange("custom")}
  >
    Custom connections
  </Button>
</div>
```

Show an amber inactive-provider banner when `providerActiveForKey` is false. Show a no-effective-connections recovery warning in custom mode when `effectiveKeyConnectionIds.length === 0`.

- [ ] **Step 4: Split global and key row behavior**

Pass:

```jsx
<ConnectionRow
  connection={conn}
  viewMode={selectedApiKey ? "api-key" : "global"}
  keySelected={selectedKeyConnectionIds.includes(conn.id)}
  onToggleKeySelected={(selected) => handleKeyConnectionToggle(conn.id, selected)}
  proxyPools={proxyPools}
  isOAuth={isOAuth}
  isFirst={index === 0}
  isLast={index === connections.length - 1}
  onMoveUp={() => handleSwapPriority(index, index - 1)}
  onMoveDown={() => handleSwapPriority(index, index + 1)}
  onToggleActive={(isActive) => handleUpdateConnectionStatus(conn.id, isActive)}
  onEdit={() => {
    setSelectedConnection(conn);
    setShowEditModal(true);
  }}
  onDelete={() => handleDelete(conn.id)}
/>
```

Global mode retains every current action. API-key mode hides priority, proxy, auto-ping, edit, delete, global activation, bulk selection, bulk proxy/delete, one-by-one tests, round-robin controls, and Add Connection. It renders:

```jsx
<Toggle
  size="sm"
  checked={keySelected}
  disabled={connection.isActive === false && !keySelected}
  onChange={onToggleKeySelected}
  title={connection.isActive === false
    ? "Globally disabled"
    : keySelected
      ? "Remove from this API key"
      : "Use for this API key"}
/>
```

Display a `Globally disabled` badge for every globally inactive row. A previously selected inactive row remains checked but ineffective.

- [ ] **Step 5: Update PropTypes, verify, and commit**

```js
viewMode: PropTypes.oneOf(["global", "api-key"]),
keySelected: PropTypes.bool,
onToggleKeySelected: PropTypes.func,
```

Run:

```bash
npx vitest run tests/unit/api-key-provider-ui-state.test.js
npx eslint 'src/app/(dashboard)/dashboard/providers/[id]/page.js' 'src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js'
```

Expected: PASS and no lint errors.

```bash
git add 'src/app/(dashboard)/dashboard/providers/[id]/page.js' 'src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js' tests/unit/api-key-provider-ui-state.test.js
git commit -m "feat: manage provider connections per API key"
```

---

### Task 8: Full Regression and Manual Verification

**Files:**
- Modify only owned files from Tasks 1-7 if verification exposes a defect.

**Interfaces:**
- Produces: test, lint, build, browser, and live-routing evidence.

- [ ] **Step 1: Run all feature/regression tests**

```bash
npx vitest run tests/unit/api-key-provider-db.test.js tests/unit/api-key-connection-api.test.js tests/unit/api-key-provider-catalog.test.js tests/unit/api-key-routing-policy.test.js tests/unit/api-key-connection-auth.test.js tests/unit/api-key-chat-routing.test.js tests/unit/api-key-gemini-routing.test.js tests/unit/api-key-provider-ui-state.test.js tests/unit/combo-routing.test.js
```

Expected: all listed files pass with no unhandled rejection.

- [ ] **Step 2: Lint every touched source file**

```bash
npx eslint src/lib/db/schema.js src/lib/db/repos/apiKeysRepo.js src/lib/db/index.js src/lib/db/migrate.js src/lib/apiKeyConnectionPolicy.js 'src/app/api/keys/route.js' 'src/app/api/keys/[id]/route.js' src/sse/services/apiKeyRouting.js src/sse/services/auth.js src/sse/handlers/chat.js 'src/app/(dashboard)/dashboard/providers/apiKeyConnectionRoutingState.js' 'src/app/(dashboard)/dashboard/providers/providerViewContext.js' 'src/app/(dashboard)/dashboard/providers/page.js' 'src/app/(dashboard)/dashboard/providers/[id]/page.js' 'src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js'
```

Expected: no errors.

- [ ] **Step 3: Build production standalone**

Run: `npm run build`

Expected: Next build and standalone asset copying complete successfully.

- [ ] **Step 4: Back up and run live routing checks**

Copy `/Users/user/.9router` to a uniquely named directory under `/private/tmp` and record the path. Then:

1. Confirm an existing NULL-policy key still uses globally active Claude connections.
2. Configure Key A with one Claude connection and Key B with a different one.
3. Send the same Claude model request with each key and record returned/logged connection IDs.
4. Configure two Key A connections, force a fallback-eligible first response, and confirm retry stays in Key A's set.
5. Globally disable a selected connection and confirm immediate ineligibility for every key.
6. Re-enable it and confirm retained selections become eligible again.

- [ ] **Step 5: Verify the browser behavior**

Confirm Global view still supports all management actions; key view preserves `?view`; inherited/custom buttons reflect persisted state; the last custom row cannot be removed; globally disabled rows are labeled and cannot be newly selected; disabled providers keep but do not apply connection policy; incognito hydration has no console error.

- [ ] **Step 6: Inspect final state and commit only verification fixes**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -12
```

Expected: only the pre-existing `CLAUDE.md` runtime modification may remain uncommitted. If a fix was needed, rerun the affected test, full feature tests, lint, and build before committing owned files with `git commit -m "fix: close API key connection routing verification"`.
