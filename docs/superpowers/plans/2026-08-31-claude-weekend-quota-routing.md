# Claude Weekend Quota Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each API key through its eligible Claude weekly-quota connections from Saturday 00:00 through Monday 07:00 Asia/Bangkok, with per-key fallback to the original connection set.

**Architecture:** Pure Bangkok-window and quota-policy modules calculate eligibility and per-key intersections. A process-global scheduler refreshes immutable Claude quota observations away from the request path, while the existing credential selector applies the overlay before rotation/retry. Settings, a redacted status endpoint, and provider UI expose control and effective state without mutating global connection flags or saved API-key policies.

**Tech Stack:** Next.js 16 App Router, React, JavaScript ES modules, SQLite repository layer, Vitest 4, existing Claude OAuth usage/refresh services.

**Spec:** `docs/superpowers/specs/2026-08-31-claude-weekend-quota-routing-design.md`

## Global Constraints

- Weekend window is Saturday 00:00 inclusive through Monday 07:00 exclusive in `Asia/Bangkok`.
- The feature affects only provider `claude`; every other provider bypasses it.
- Eligibility uses only the generic Claude quota key `weekly (7d)`.
- A connection is eligible only when remaining is greater than zero, reset is after now and no later than the closing Monday 07:00, and the observation is at most 15 minutes old.
- Effective routing is `global active ∩ saved per-key Claude connections ∩ weekend eligible`.
- If that intersection is empty, fallback independently to that key's original Claude base set in every case.
- Never mutate global `isActive`, `activeProviders`, or `activeConnections` from the scheduler.
- Missing `claudeWeekendRouting` settings mean `{ enabled: true }`.
- Quota calls are sequential, scheduler ticks do not overlap, and routing never calls an upstream quota API.
- Status responses and logs never contain tokens, API keys, proxy credentials, account names, or raw upstream error bodies.
- Preserve the user's existing modified `CLAUDE.md`; never stage, commit, or revert it.
- Run Vitest with `--config tests/vitest.config.js` and explicit test paths.

---

## File Structure

- `src/shared/services/claudeWeekendRouting/window.js`: Bangkok calendar boundaries only.
- `src/shared/services/claudeWeekendRouting/policy.js`: quota evaluation and per-key overlay resolution only.
- `src/shared/services/claudeWeekendRouting/service.js`: scheduler lifecycle, quota refresh, atomic snapshot, and status projection.
- `src/shared/constants/config.js`: scheduler interval, freshness, timezone, and quota-key constants.
- `open-sse/services/usage/claude.js`: backward-compatible quota observation metadata.
- `src/lib/db/repos/settingsRepo.js`: enabled-by-default setting.
- `src/shared/services/initializeApp.js`: idempotent startup configuration.
- `src/app/api/settings/route.js`: immediate scheduler reconfiguration after toggle changes.
- `src/app/api/providers/claude/weekend-routing/route.js`: authenticated, redacted status endpoint.
- `src/sse/services/auth.js`: request-time Claude overlay before existing selection strategies.
- `src/app/(dashboard)/dashboard/profile/ClaudeWeekendRoutingSettings.jsx`: Settings control and summary.
- `src/app/(dashboard)/dashboard/profile/page.js`: mounts the focused Settings component.
- `src/app/(dashboard)/dashboard/providers/[id]/claudeWeekendStatusUi.js`: pure badge/copy projection.
- `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`: renders an optional effective-status badge.
- `src/app/(dashboard)/dashboard/providers/[id]/page.js`: loads status and passes per-connection/per-key state.
- `tests/unit/claude-weekend-window.test.js`: time boundaries.
- `tests/unit/claude-weekend-policy.test.js`: eligibility and per-key fallback.
- `tests/unit/claude-usage-observation.test.js`: fresh/cache/stale metadata.
- `tests/unit/claude-weekend-scheduler.test.js`: scheduler and immutable snapshot behavior.
- `tests/unit/claude-weekend-settings-api.test.js`: default, toggle, and status redaction.
- `tests/unit/claude-weekend-routing.test.js`: credential-selection integration.
- `tests/unit/claude-weekend-ui-state.test.js`: Settings and badge view models.

---

### Task 1: Bangkok Window and Routing Policy Primitives

**Files:**
- Create: `src/shared/services/claudeWeekendRouting/window.js`
- Create: `src/shared/services/claudeWeekendRouting/policy.js`
- Create: `tests/unit/claude-weekend-window.test.js`
- Create: `tests/unit/claude-weekend-policy.test.js`

**Interfaces:**
- Produces: `getClaudeWeekendWindow(now: Date|number) -> { active, startAt, endAt, nextBoundaryAt }` where timestamps are ISO strings.
- Produces: `evaluateClaudeWeeklyQuota({ quota, observedAt, now, windowEndAt, maxAgeMs }) -> { eligible, reason, remaining, resetAt, observedAt }`.
- Produces: `resolveClaudeWeekendRouting({ providerId, baseAllowedConnectionIds, globalConnections, snapshot, enabled, now, maxAgeMs }) -> { allowedConnectionIds, mode }` where `allowedConnectionIds` is the original `Set|null` or a non-empty filtered `Set`, and mode is `inactive|filtered|fallback`.

- [ ] **Step 1: Write failing Bangkok boundary tests**

```js
import { describe, expect, it } from "vitest";
import { getClaudeWeekendWindow } from "../../src/shared/services/claudeWeekendRouting/window.js";

describe("Claude weekend Bangkok window", () => {
  it.each([
    ["2026-08-28T16:59:59.000Z", false], // Friday 23:59:59 Bangkok
    ["2026-08-28T17:00:00.000Z", true],  // Saturday 00:00
    ["2026-08-30T23:59:59.000Z", true],  // Monday 06:59:59
    ["2026-08-31T00:00:00.000Z", false], // Monday 07:00
  ])("evaluates %s", (iso, active) => {
    expect(getClaudeWeekendWindow(new Date(iso)).active).toBe(active);
  });

  it("closes the active weekend at Monday 07:00 Bangkok", () => {
    expect(getClaudeWeekendWindow(new Date("2026-08-29T05:00:00.000Z")).endAt)
      .toBe("2026-08-31T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run the boundary test and verify RED**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-window.test.js`

Expected: FAIL because `window.js` does not exist.

- [ ] **Step 3: Implement explicit Bangkok calendar calculation**

```js
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const WEEKEND_DURATION_MS = 55 * 60 * 60 * 1000;

function bangkokParts(nowMs) {
  const shifted = new Date(nowMs + BANGKOK_OFFSET_MS);
  return {
    day: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
    localMidnightMs: Date.UTC(
      shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
    ) - BANGKOK_OFFSET_MS,
  };
}

export function getClaudeWeekendWindow(now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid clock");

  const parts = bangkokParts(nowMs);
  const beforeMondayClose = parts.day === 1 && (
    parts.hour < 7
  );
  let activeStartMs = null;
  if (parts.day === 6) activeStartMs = parts.localMidnightMs;
  if (parts.day === 0) activeStartMs = parts.localMidnightMs - 24 * 60 * 60 * 1000;
  if (beforeMondayClose) activeStartMs = parts.localMidnightMs - 48 * 60 * 60 * 1000;

  const active = activeStartMs !== null;
  const daysUntilSaturday = (6 - parts.day + 7) % 7;
  const startMs = active
    ? activeStartMs
    : parts.localMidnightMs + daysUntilSaturday * 24 * 60 * 60 * 1000;
  const endMs = startMs + WEEKEND_DURATION_MS;
  return {
    active,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    nextBoundaryAt: new Date(active ? endMs : startMs).toISOString(),
  };
}
```

The implementation must return finite ISO timestamps and throw `TypeError("Invalid clock")` for an invalid date.

- [ ] **Step 4: Write failing quota and per-key policy tests**

```js
const observedAt = "2026-08-29T04:55:00.000Z";
const resetAt = "2026-08-30T12:00:00.000Z";
const eligibleObservation = {
  eligible: true,
  reason: "eligible",
  remaining: 42,
  resetAt,
  observedAt,
};
const freshSnapshot = (connections) => ({
  enabled: true,
  currentlyActive: true,
  connections,
});

it("filters an eligible key intersection", () => {
  const result = resolveClaudeWeekendRouting({
    providerId: "claude",
    baseAllowedConnectionIds: new Set(["c1", "c2"]),
    globalConnections: [{ id: "c1" }, { id: "c2" }],
    snapshot: freshSnapshot({ c2: eligibleObservation }),
    enabled: true,
    now: new Date("2026-08-29T05:00:00.000Z"),
    maxAgeMs: 900000,
  });
  expect([...result.allowedConnectionIds]).toEqual(["c2"]);
  expect(result.mode).toBe("filtered");
});

it("falls back per key when its eligible intersection is empty", () => {
  const base = new Set(["c1"]);
  const result = resolveClaudeWeekendRouting({
    providerId: "claude",
    baseAllowedConnectionIds: base,
    globalConnections: [{ id: "c1" }, { id: "c2" }],
    snapshot: freshSnapshot({ c2: eligibleObservation }),
    enabled: true,
    now: new Date("2026-08-29T05:00:00.000Z"),
    maxAgeMs: 900000,
  });
  expect(result.allowedConnectionIds).toBe(base);
  expect(result.mode).toBe("fallback");
});
```

Add cases for remaining `0`, derived remaining, invalid reset, elapsed reset, reset exactly at Monday 07:00, reset after the boundary, a 15-minute observation, a 15-minute-plus-1ms observation, disabled setting, Monday 07:00, unrestricted base `null`, globally inactive omission, and non-Claude bypass.

- [ ] **Step 5: Run the policy test and verify RED**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-policy.test.js`

Expected: FAIL because `policy.js` does not exist.

- [ ] **Step 6: Implement the minimal policy functions**

Use stable reason codes:

```js
export const CLAUDE_WEEKEND_REASON = Object.freeze({
  ELIGIBLE: "eligible",
  WEEKLY_EXHAUSTED: "weekly_exhausted",
  RESET_ELAPSED: "reset_elapsed",
  RESETS_AFTER_WINDOW: "resets_after_window",
  QUOTA_UNAVAILABLE: "quota_unavailable",
  STALE: "stale",
});

export function evaluateClaudeWeeklyQuota({ quota, observedAt, now, windowEndAt, maxAgeMs }) {
  const nowMs = new Date(now).getTime();
  const observedMs = new Date(observedAt).getTime();
  if (!quota || !Number.isFinite(observedMs)) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.QUOTA_UNAVAILABLE };
  }
  if (nowMs - observedMs > maxAgeMs) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.STALE, observedAt };
  }
  const remaining = Number.isFinite(Number(quota.remaining))
    ? Number(quota.remaining)
    : Number(quota.total) - Number(quota.used);
  if (!Number.isFinite(remaining)) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.QUOTA_UNAVAILABLE, observedAt };
  }
  if (remaining <= 0) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.WEEKLY_EXHAUSTED, remaining, observedAt };
  }
  const resetMs = new Date(quota.resetAt).getTime();
  if (!Number.isFinite(resetMs)) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.QUOTA_UNAVAILABLE, remaining, observedAt };
  }
  if (resetMs <= nowMs) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.RESET_ELAPSED, remaining, resetAt: quota.resetAt, observedAt };
  }
  if (resetMs > new Date(windowEndAt).getTime()) {
    return { eligible: false, reason: CLAUDE_WEEKEND_REASON.RESETS_AFTER_WINDOW, remaining, resetAt: quota.resetAt, observedAt };
  }
  return { eligible: true, reason: CLAUDE_WEEKEND_REASON.ELIGIBLE, remaining, resetAt: quota.resetAt, observedAt };
}

export function resolveClaudeWeekendRouting(input) {
  const original = input.baseAllowedConnectionIds;
  const window = getClaudeWeekendWindow(input.now);
  if (input.providerId !== "claude" || input.enabled !== true || !window.active) {
    return { allowedConnectionIds: original, mode: "inactive" };
  }

  const globalIds = new Set(input.globalConnections.map((connection) => connection.id));
  const baseIds = original === null
    ? globalIds
    : new Set([...original].filter((id) => globalIds.has(id)));
  const filtered = new Set([...baseIds].filter((id) => {
    const observation = input.snapshot?.connections?.[id];
    return evaluateClaudeWeeklyQuota({
      quota: observation,
      observedAt: observation?.observedAt,
      now: input.now,
      windowEndAt: window.endAt,
      maxAgeMs: input.maxAgeMs,
    }).eligible;
  }));
  return filtered.size > 0
    ? { allowedConnectionIds: filtered, mode: "filtered" }
    : { allowedConnectionIds: original, mode: "fallback" };
}
```

Never mutate the caller's sets, arrays, connections, or snapshot. Preserve the exact original `baseAllowedConnectionIds` object on fallback/inactive results.

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-window.test.js tests/unit/claude-weekend-policy.test.js`

Expected: all Task 1 tests PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/shared/services/claudeWeekendRouting/window.js src/shared/services/claudeWeekendRouting/policy.js tests/unit/claude-weekend-window.test.js tests/unit/claude-weekend-policy.test.js
git commit -m "feat: add Claude weekend routing policy"
```

---

### Task 2: Fresh Claude Usage Observations

**Files:**
- Modify: `open-sse/services/usage/claude.js:17-57`
- Create: `tests/unit/claude-usage-observation.test.js`

**Interfaces:**
- Produces: `getClaudeUsageObservation(accessToken, proxyOptions?, options?) -> { result, observedAt, source, stale }`.
- Preserves: `getClaudeUsage(...) -> usageResult` for every existing caller.
- Consumes later: scheduler trusts `observedAt` only when it originated from a successful upstream quota response; stale-on-error keeps the old timestamp.

- [ ] **Step 1: Write failing observation tests**

Mock `proxyAwareFetch` and assert:

```js
const first = await getClaudeUsageObservation("token");
expect(first).toMatchObject({ source: "upstream", stale: false });
expect(first.result.quotas["weekly (7d)"].remaining).toBe(80);

const cached = await getClaudeUsageObservation("token");
expect(cached).toMatchObject({ source: "cache", stale: false, observedAt: first.observedAt });

vi.setSystemTime(new Date(Date.parse(first.observedAt) + 300001));
proxyAwareFetch.mockResolvedValueOnce({ ok: false, status: 429 });
const stale = await getClaudeUsageObservation("token");
expect(stale).toMatchObject({ source: "stale", stale: true, observedAt: first.observedAt });
```

Also prove two concurrent callers share one upstream promise and that the legacy `getClaudeUsage` return shape has no observation wrapper.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-usage-observation.test.js`

Expected: FAIL because `getClaudeUsageObservation` is not exported.

- [ ] **Step 3: Refactor the cache without changing legacy callers**

Store cache entries as `{ result, observedAt, expiresAt }` or `{ promise }`. Implement:

```js
export async function getClaudeUsageObservation(accessToken, proxyOptions = null, options = {}) {
  const force = options?.force === true;
  const hit = accessToken ? usageCache.get(accessToken) : null;
  if (!force && hit?.promise) return hit.promise;
  if (!force && hit?.result && hit.expiresAt > Date.now()) {
    return {
      result: hit.result,
      observedAt: hit.observedAt,
      source: hit.stale === true ? "stale" : "cache",
      stale: hit.stale === true,
    };
  }

  const staleEntry = !force && hit?.result ? hit : null;
  const promise = (async () => {
    const result = await fetchClaudeUsageRaw(accessToken, proxyOptions);
    if (result?.quotas) {
      const observedAt = new Date().toISOString();
      if (accessToken) usageCache.set(accessToken, {
        result,
        observedAt,
        expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
      });
      return { result, observedAt, source: "upstream", stale: false };
    }
    if (staleEntry) {
      if (accessToken) usageCache.set(accessToken, {
        ...staleEntry,
        stale: true,
        expiresAt: Date.now() + OAUTH_429_COOLDOWN_MS,
      });
      return {
        result: staleEntry.result,
        observedAt: staleEntry.observedAt,
        source: "stale",
        stale: true,
      };
    }
    return { result, observedAt: null, source: "upstream", stale: false };
  })();

  if (accessToken) usageCache.set(accessToken, { promise });
  try {
    return await promise;
  } finally {
    if (accessToken && usageCache.get(accessToken)?.promise === promise) {
      usageCache.delete(accessToken);
    }
  }
}

export async function getClaudeUsage(accessToken, proxyOptions = null, options = {}) {
  return (await getClaudeUsageObservation(accessToken, proxyOptions, options)).result;
}
```

Do not use token values in cache logs or returned metadata.

- [ ] **Step 4: Run focused and existing quota tests**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-usage-observation.test.js tests/unit/quota-auto-ping.test.js`

Expected: all tests PASS and auto-ping still receives the legacy usage shape.

- [ ] **Step 5: Commit Task 2**

```bash
git add open-sse/services/usage/claude.js tests/unit/claude-usage-observation.test.js
git commit -m "feat: expose fresh Claude quota observations"
```

---

### Task 3: Scheduler and Immutable Snapshot

**Files:**
- Modify: `src/shared/constants/config.js:47-82`
- Create: `src/shared/services/claudeWeekendRouting/service.js`
- Create: `tests/unit/claude-weekend-scheduler.test.js`

**Interfaces:**
- Produces: `runClaudeWeekendRoutingTick(deps?, state?, now?) -> Promise<void>`.
- Produces: `getClaudeWeekendRoutingSnapshot() -> frozen snapshot`.
- Produces: `startClaudeWeekendRouting()`, `stopClaudeWeekendRouting()`, and `configureClaudeWeekendRouting(settings)`.
- Consumes: Task 1 window/policy functions and Task 2 `getClaudeUsageObservation`.

- [ ] **Step 1: Add failing scheduler tests with injected dependencies**

Use a local state object and dependencies:

```js
const deps = {
  getSettings: vi.fn().mockResolvedValue({ claudeWeekendRouting: { enabled: true } }),
  getProviderConnections: vi.fn().mockResolvedValue([
    { id: "c1", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-1" },
    { id: "c2", provider: "claude", authType: "oauth", isActive: true, accessToken: "token-2" },
  ]),
  refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
  getClaudeUsageObservation: vi.fn(),
};
```

Assert startup-weekend refresh, disabled/outside-window no upstream calls, globally inactive exclusion through the DB filter, non-OAuth exclusion, sequential usage calls, one-connection failure isolation, stale observation reason, frozen published snapshot, overlap prevention, and older-generation rejection.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-scheduler.test.js`

Expected: FAIL because the scheduler service does not exist.

- [ ] **Step 3: Add configuration constants**

```js
export const CLAUDE_WEEKEND_ROUTING_CONFIG = Object.freeze({
  timezone: "Asia/Bangkok",
  quotaKey: "weekly (7d)",
  tickIntervalMs: 10 * 60 * 1000,
  maxObservationAgeMs: 15 * 60 * 1000,
});
```

- [ ] **Step 4: Implement scheduler state and dependency boundary**

The global state must include only operational data:

```js
const g = (global.__claudeWeekendRouting ??= {
  interval: null,
  running: false,
  generation: 0,
  snapshot: Object.freeze({
    generation: 0,
    enabled: true,
    currentlyActive: false,
    lastCompletedAt: null,
    windowStartAt: null,
    windowEndAt: null,
    connections: Object.freeze({}),
  }),
});
```

Publish a newly frozen snapshot only after all target connections have been evaluated. Process connections with `for...of` and `await`; do not use `Promise.all`.

The tick logs one completion line containing duration and counts for
`eligible`, `weekly_exhausted`, `resets_after_window`, `quota_unavailable`, and
`stale`. It logs connection IDs only for per-connection failures and never logs
the usage payload.

- [ ] **Step 5: Implement lifecycle behavior**

`startClaudeWeekendRouting()` runs an immediate tick and installs one unref'd 10-minute interval. `configureClaudeWeekendRouting(settings)` updates the enabled state immediately, clears eligibility when disabled, and triggers an immediate tick when enabled. `stopClaudeWeekendRouting()` clears only its own timer.

- [ ] **Step 6: Run and verify GREEN**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-window.test.js tests/unit/claude-weekend-policy.test.js tests/unit/claude-usage-observation.test.js tests/unit/claude-weekend-scheduler.test.js tests/unit/quota-auto-ping.test.js`

Expected: all scheduler and existing quota tests PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/shared/constants/config.js src/shared/services/claudeWeekendRouting/service.js tests/unit/claude-weekend-scheduler.test.js
git commit -m "feat: schedule Claude weekend quota snapshots"
```

---

### Task 4: Default Setting, Startup, and Redacted Status API

**Files:**
- Modify: `src/lib/db/repos/settingsRepo.js:6-49`
- Modify: `src/shared/services/initializeApp.js:100-125`
- Modify: `src/app/api/settings/route.js:88-116`
- Create: `src/app/api/providers/claude/weekend-routing/route.js`
- Create: `tests/unit/claude-weekend-settings-api.test.js`

**Interfaces:**
- Settings shape: `claudeWeekendRouting: { enabled: boolean }`, default `{ enabled: true }`.
- Endpoint: `GET /api/providers/claude/weekend-routing?apiKeyId=<database-id>`.
- Endpoint output: `{ enabled, currentlyActive, mode, windowStartAt, windowEndAt, lastCompletedAt, hasEligibleConnections, connections }` with only ID/reason/quota timestamps and percentages.

- [ ] **Step 1: Write failing default and API tests**

Assert `mergeWithDefaults({}).claudeWeekendRouting` equals `{ enabled: true }`. Mock the service snapshot and local DB, call the route, and assert:

```js
expect(body.connections.c1).toEqual({
  eligible: true,
  reason: "eligible",
  remaining: 42,
  resetAt: "2026-08-30T12:00:00.000Z",
  observedAt: "2026-08-29T05:00:00.000Z",
});
expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|apiKey|proxy/i);
```

Add tests for unknown `apiKeyId` returning 404, Global view omitting per-key mode, filtered mode, and per-key fallback mode.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-settings-api.test.js`

Expected: FAIL because the default and route do not exist.

- [ ] **Step 3: Add the enabled-by-default setting**

Add to `DEFAULT_SETTINGS`:

```js
claudeWeekendRouting: { enabled: true },
```

Keep the normal read-merge-write behavior; no schema migration is required.

- [ ] **Step 4: Wire startup and immediate toggle configuration**

In `initializeApp`, dynamically import `configureClaudeWeekendRouting` and pass the already-loaded merged settings. In the Settings PATCH route, when the body owns `claudeWeekendRouting`, call the same configure function with the saved merged settings. Catch and log only the error message.

- [ ] **Step 5: Implement the redacted status route**

Load a snapshot through `getClaudeWeekendRoutingSnapshot()`. When `apiKeyId` is present, load keys through `getApiKeys()`, find the database ID, obtain its Claude base selection, and call the Task 1 resolver using safe connection objects `{ id, provider, isActive }`. Return 404 rather than silently treating an unknown key as Global.

The route must construct an allowlisted response object; never spread DB connections, settings, or upstream usage objects.
The normal application authentication middleware protects the route; do not add
a second token/password mechanism inside this endpoint.

- [ ] **Step 6: Run focused settings/startup/API tests**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-settings-api.test.js tests/unit/claude-weekend-scheduler.test.js tests/unit/api-key-provider-db.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/lib/db/repos/settingsRepo.js src/shared/services/initializeApp.js src/app/api/settings/route.js src/app/api/providers/claude/weekend-routing/route.js tests/unit/claude-weekend-settings-api.test.js
git commit -m "feat: configure Claude weekend routing"
```

---

### Task 5: Claude Credential-Selection Integration

**Files:**
- Modify: `src/sse/services/auth.js:20-95`
- Create: `tests/unit/claude-weekend-routing.test.js`
- Modify: `tests/unit/api-key-connection-auth.test.js`

**Interfaces:**
- Consumes: `resolveClaudeWeekendRouting(...)` and `getClaudeWeekendRoutingSnapshot()`.
- Preserves: `getProviderCredentials(provider, excludeConnectionIds, model, options)` public signature.
- The existing `options.allowedConnectionIds` remains the API-key base policy; the weekend resolver may narrow it or return it unchanged.

- [ ] **Step 1: Write failing credential-selection tests**

Mock three globally active Claude connections and an active weekend snapshot. Assert:

```js
const credentials = await getProviderCredentials("claude", null, "claude-sonnet", {
  allowedConnectionIds: new Set(["c1", "c2"]),
});
expect(credentials.id).toBe("c2"); // only c2 is weekend eligible
```

Add tests proving:

- a key restricted to `c1` falls back to `c1` when only `c2` is eligible;
- unrestricted base `null` uses all eligible connections when at least one exists;
- globally inactive connections never enter the base set;
- Monday 07:00 returns existing behavior;
- setting disabled returns existing behavior;
- `codex` and other providers never call the weekend resolver;
- retry exclusions and model locks still apply after the weekend set;
- rotation cannot escape the resolved filtered set.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-routing.test.js tests/unit/api-key-connection-auth.test.js`

Expected: new weekend-selection assertions FAIL because auth ignores the snapshot.

- [ ] **Step 3: Apply the overlay after loading the global active base**

In `getProviderCredentials`, keep the existing global query:

```js
const globalConnections = await getProviderConnections({ provider: providerId, isActive: true });
```

For Claude only, resolve the effective allowed IDs using the current snapshot and clock. Then filter `globalConnections` with the returned set. For every other provider, keep the existing `allowedConnectionIds` path byte-for-byte equivalent.

Do not fetch settings or quota data in `getProviderCredentials`; the in-memory snapshot contains the effective enabled state.

- [ ] **Step 4: Run routing, chat, and Gemini regressions**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-routing.test.js tests/unit/api-key-connection-auth.test.js tests/unit/api-key-chat-routing.test.js tests/unit/api-key-gemini-routing.test.js tests/unit/combo-routing.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/sse/services/auth.js tests/unit/claude-weekend-routing.test.js tests/unit/api-key-connection-auth.test.js
git commit -m "feat: enforce Claude weekend routing overlay"
```

---

### Task 6: Settings Control and Claude Effective-Status UI

**Files:**
- Create: `src/app/(dashboard)/dashboard/profile/ClaudeWeekendRoutingSettings.jsx`
- Modify: `src/app/(dashboard)/dashboard/profile/page.js:20-40,1425-1540`
- Create: `src/app/(dashboard)/dashboard/providers/[id]/claudeWeekendStatusUi.js`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js:1-360`
- Modify: `src/app/(dashboard)/dashboard/providers/[id]/page.js:50-120,300-540,1080-1145,1650-1735`
- Create: `tests/unit/claude-weekend-ui-state.test.js`

**Interfaces:**
- `ClaudeWeekendRoutingSettings({ settings, loading, onSaved })` PATCHes only `{ claudeWeekendRouting: { enabled } }`.
- `getClaudeWeekendBadge(status) -> { label, tone }` maps stable reason codes to copy.
- `ConnectionRow` gains optional `weekendStatus` with `{ eligible, reason, remaining, resetAt, observedAt }`.

- [ ] **Step 1: Write failing pure UI-state tests**

```js
it.each([
  ["eligible", "Weekend eligible", "success"],
  ["weekly_exhausted", "Weekly exhausted", "warning"],
  ["resets_after_window", "Resets after window", "muted"],
  ["quota_unavailable", "Quota unavailable", "danger"],
])("maps %s", (reason, label, tone) => {
  expect(getClaudeWeekendBadge({ reason })).toEqual({ label, tone });
});
```

Also assert inactive mode copy, filtered-key copy, fallback-key copy, and that the status projection contains no credential-shaped properties.

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-ui-state.test.js`

Expected: FAIL because the UI-state module does not exist.

- [ ] **Step 3: Implement the Settings component**

Render within the existing Routing Strategy card:

```jsx
<ClaudeWeekendRoutingSettings
  settings={settings}
  loading={loading}
  onSaved={(saved) => setSettings((current) => ({ ...current, ...saved }))}
/>
```

The component renders a Toggle, `Saturday 00:00 – Monday 07:00 (Asia/Bangkok)`, optimistic-disabled loading state, success/error text, and rolls back the displayed switch when PATCH fails.

- [ ] **Step 4: Load Claude status without blocking provider data**

In provider detail, only when `providerId === "claude"`, fetch:

```js
const suffix = isKeyView ? `?apiKeyId=${encodeURIComponent(selectedView)}` : "";
fetch(`/api/providers/claude/weekend-routing${suffix}`)
```

Run the status request independently from provider/key catalog loading. Poll once per minute while the page is visible. On failure, show `Quota unavailable` status without hiding connection management or exposing Global controls in a requested key view.

- [ ] **Step 5: Render connection and per-key mode badges**

Pass `weekendStatus={weekendStatus?.connections?.[conn.id] || null}` into each Claude `ConnectionRow`. Render the badge near existing connection status, without changing the saved active Toggle. Above the list, render one of:

- `Weekend filter active for this API key`
- `No eligible connection for this API key — using original configuration`
- `Weekend mode inactive`

- [ ] **Step 6: Run UI and prior API-key UI tests**

Run: `npx vitest run --config tests/vitest.config.js tests/unit/claude-weekend-ui-state.test.js tests/unit/api-key-provider-ui-state.test.js tests/unit/header-provider-view-context.test.js`

Expected: all tests PASS.

- [ ] **Step 7: Run ESLint on UI files**

Run:

```bash
npx eslint \
  'src/app/(dashboard)/dashboard/profile/ClaudeWeekendRoutingSettings.jsx' \
  'src/app/(dashboard)/dashboard/profile/page.js' \
  'src/app/(dashboard)/dashboard/providers/[id]/claudeWeekendStatusUi.js' \
  'src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js' \
  'src/app/(dashboard)/dashboard/providers/[id]/page.js'
```

Expected: 0 errors; document rather than broaden scope for any pre-existing warning.

- [ ] **Step 8: Commit Task 6**

```bash
git add 'src/app/(dashboard)/dashboard/profile/ClaudeWeekendRoutingSettings.jsx' 'src/app/(dashboard)/dashboard/profile/page.js' 'src/app/(dashboard)/dashboard/providers/[id]/claudeWeekendStatusUi.js' 'src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js' 'src/app/(dashboard)/dashboard/providers/[id]/page.js' tests/unit/claude-weekend-ui-state.test.js
git commit -m "feat: show Claude weekend routing status"
```

---

### Task 7: Full Regression and Isolated Browser Verification

**Files:**
- Modify only if a verification defect requires a focused fix and regression test.

**Interfaces:**
- Verifies all interfaces from Tasks 1-6 together.

- [ ] **Step 1: Run the complete feature regression**

Run:

```bash
npx vitest run --config tests/vitest.config.js \
  tests/unit/claude-weekend-window.test.js \
  tests/unit/claude-weekend-policy.test.js \
  tests/unit/claude-usage-observation.test.js \
  tests/unit/claude-weekend-scheduler.test.js \
  tests/unit/claude-weekend-settings-api.test.js \
  tests/unit/claude-weekend-routing.test.js \
  tests/unit/claude-weekend-ui-state.test.js \
  tests/unit/quota-auto-ping.test.js \
  tests/unit/api-key-provider-db.test.js \
  tests/unit/api-key-connection-api.test.js \
  tests/unit/api-key-connection-auth.test.js \
  tests/unit/api-key-chat-routing.test.js \
  tests/unit/api-key-gemini-routing.test.js \
  tests/unit/api-key-provider-ui-state.test.js \
  tests/unit/combo-routing.test.js \
  tests/unit/header-provider-view-context.test.js \
  tests/unit/db-migration-chain.test.js
```

Expected: every listed test file PASS.

- [ ] **Step 2: Run touched-source ESLint and diff checks**

Run ESLint on every source file listed in Tasks 1-6, then run `git diff --check`.

Expected: 0 ESLint errors and no whitespace errors.

- [ ] **Step 3: Run an isolated production build**

```bash
ISOLATED_DATA_DIR=$(mktemp -d /private/tmp/9router-claude-weekend.XXXXXX)
env DATA_DIR="$ISOLATED_DATA_DIR" npm run build
```

Expected: Next compilation, TypeScript checks, all static pages, and postbuild standalone asset copy PASS.

- [ ] **Step 4: Run isolated browser verification**

Start the standalone build on a non-live port with a copy of the local database under a unique `/private/tmp` directory. Do not mutate `/Users/user/.9router` and do not send real Claude chat traffic.

Verify:

1. Settings shows an enabled `Claude Weekend Routing` switch and exact Bangkok schedule.
2. Toggling off/on persists and updates status without restart.
3. Claude Global view displays per-connection status badges but unchanged saved active toggles.
4. Claude API-key view reports `filtered` or `fallback` for that key and preserves `?view` navigation.
5. A clock-injected status/API test proves Monday 07:00 is inactive; do not change the host clock.
6. Browser console has no errors and status responses contain no credential fields.

- [ ] **Step 5: Record deferred live-provider verification**

Document that real Anthropic quota calls and outbound Claude routing are deferred until deployment approval. Do not claim they passed from mocked/isolated evidence.

- [ ] **Step 6: Commit any verification fix**

If verification found a defect, first add a failing regression test, make the minimal fix, rerun Steps 1-4, and commit only those files:

```bash
git commit -m "fix: harden Claude weekend routing verification"
```

If no files changed, do not create an empty commit.

---

## Final Review Gate

After Task 7 is green:

1. Request a whole-branch review from the feature branch merge base through HEAD.
2. Review end-to-end behavior through settings, scheduler, usage freshness, auth selection, retries, status redaction, and UI.
3. Fix every Critical or Important finding with a failing regression test.
4. Re-run the complete feature regression, touched-source ESLint, isolated production build, and browser checks.
5. Use `superpowers:verification-before-completion` before claiming success.
6. Use `superpowers:finishing-a-development-branch` to offer local merge, PR, or branch preservation.
