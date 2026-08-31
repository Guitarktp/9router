# Claude Weekend Quota Routing — Final Fix Wave Report

## Scope

- Checkout: `/Users/user/Documents/Project/9router` on `custom/pegasus`, starting at `819872a2`.
- Protected user-owned `CLAUDE.md` was neither edited nor staged.
- This wave addresses every final-review finding: request-time status freshness, Global inactive notice, actual scheduler completion timestamps, `reset_elapsed` counters, lightweight status-state import, and null-safe proxy logging.

## RED evidence

Focused RED command:

```bash
npx vitest run --config tests/vitest.config.js \
  tests/unit/claude-weekend-settings-api.test.js \
  tests/unit/claude-weekend-policy.test.js \
  tests/unit/claude-weekend-ui-state.test.js \
  tests/unit/claude-weekend-scheduler.test.js \
  tests/unit/claude-weekend-safe-logging.test.js
```

Result before production changes: **5 files failed; 16 tests failed; 49 passed**.

- Global status accepted a 15-minute-plus-1ms old `eligible: true` snapshot entry and still reported `hasEligibleConnections: true`.
- API-key status accepted an `eligible: true` entry whose reset had elapsed; it disagreed with routing fallback.
- The policy resolver could promote an already scheduler-known ineligible observation when its remaining/reset fields looked eligible.
- The pure Global-notice consumer did not exist, so disabled/outside-window Global status could not cause rendering.
- Scheduler `lastCompletedAt` used the tick evaluation input time rather than a completion clock.
- Completion counters omitted `reset_elapsed`.
- `resolveConnectionProxyConfig(..., null)` rejected from its error handler by dereferencing `options.safeLogging`.
- Moving the status-test snapshot mock to `state.js` exposed that the route still imported the scheduler service, producing the expected missing-export RED failures.

## Fixes

- Status now obtains its snapshot from lightweight `state.js`, calculates the current Bangkok window at request time, and re-evaluates only scheduler-eligible entries through `evaluateClaudeWeeklyQuota` with the shared 15-minute maximum age. It derives projected connection eligibility, `hasEligibleConnections`, and per-key routing mode from the same current-time inputs.
- The policy resolver requires `observation.eligible === true` before it can retain a connection, so known ineligible scheduler observations cannot be promoted later.
- Global Claude views now render `Weekend mode inactive` when a loaded status is disabled or currently outside the weekend; API-key filtered/fallback behavior remains unchanged.
- Scheduler publishes `lastCompletedAt` from an injectable completion clock, and fixed counters include `reset_elapsed`.
- Proxy-resolution fallback checks `options?.safeLogging`, including explicit `null` callers.

## GREEN evidence

Focused GREEN command after the fix:

```bash
npx vitest run --config tests/vitest.config.js \
  tests/unit/claude-weekend-settings-api.test.js \
  tests/unit/claude-weekend-policy.test.js \
  tests/unit/claude-weekend-ui-state.test.js \
  tests/unit/claude-weekend-scheduler.test.js \
  tests/unit/claude-weekend-safe-logging.test.js
```

Result: **5 files passed; 65 tests passed**.

Full Task 7 regression plus new safe-logging coverage:

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
  tests/unit/db-migration-chain.test.js \
  tests/unit/claude-weekend-safe-logging.test.js
```

Result: **18 files passed; 195 tests passed**.

Touched-source lint:

```bash
npx eslint \
  src/shared/services/claudeWeekendRouting/policy.js \
  src/app/api/providers/claude/weekend-routing/route.js \
  src/shared/services/claudeWeekendRouting/service.js \
  src/lib/network/connectionProxy.js \
  'src/app/(dashboard)/dashboard/providers/[id]/claudeWeekendStatusUi.js' \
  'src/app/(dashboard)/dashboard/providers/[id]/page.js'
```

Result: **0 errors**.

`git diff --check`: **success with no output**.

Isolated production build:

```bash
env DATA_DIR=/private/tmp/9router-final-fix.cSV4wg npm run build
```

Result: **successful Next webpack compilation, TypeScript check, 135 static pages, and standalone asset copy**.

## Isolated Playwright verification

- Server: standalone build on `http://127.0.0.1:30279`, never the live `20128` port.
- Data: `/private/tmp/9router-final-fix.cSV4wg`; it contained only two inert fixture Claude connections and two placeholder API-key records. `requireLogin` was disabled only in that temporary DB. `DISABLE_BACKGROUND_TOKEN_REFRESH=1` was set.
- Settings rendered the checked `Claude Weekend Routing` switch and exact `Saturday 00:00 – Monday 07:00 (Asia/Bangkok)` copy. Toggling off displayed `Claude weekend routing disabled`; toggling on completed without restart.
- The unmocked Global view rendered `Weekend mode inactive` outside the current weekend, while both saved connection switches remained checked.
- The unmocked status response was HTTP 200 with only allowed status fields and no credential-shaped fields. It reported `currentlyActive: false` and `hasEligibleConnections: false` outside the weekend.
- A local mock of only `/api/providers/claude/weekend-routing*` rendered both `Weekend eligible` and `Weekly exhausted` badges in Global view.
- Filtered and fallback local status mocks rendered their exact API-key notices; the addresses retained `?view=browser-key-filtered` and `?view=browser-key-fallback`.
- The final direct browser console check reported **0 errors, 0 warnings**. Browser request inspection showed no Anthropic, Claude chat, `/api/usage`, or quota request. The app emitted existing Google Analytics beacons; these are unrelated telemetry and did not contain provider credentials.

## Deferred validation and cleanup

Real Anthropic quota calls and outbound Claude routing remain deferred pending deployment approval; this report makes no live-provider claim.

The isolated Playwright browser, loopback server, and temporary data directory were removed after evidence capture. No live data or live process was modified.
