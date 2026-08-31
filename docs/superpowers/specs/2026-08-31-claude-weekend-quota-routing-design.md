# Claude Weekend Quota Routing Design

## Summary

Add an opt-out Claude-only routing overlay that runs every weekend in the
`Asia/Bangkok` timezone. From Saturday 00:00 through Monday 07:00, each API key
prefers only globally active Claude connections that still have generic weekly
quota and whose current weekly window resets no later than Monday 07:00. The
overlay never mutates a connection's global `isActive` flag or an API key's
stored provider/connection policy.

If applying the weekend eligible set would leave a particular API key with no
Claude connection, that key falls back to its original Claude connection set.
At Monday 07:00 the overlay stops applying immediately, so every key returns to
its original routing without a restore job.

## Goals

- Use remaining Claude weekly quota that will expire/reset before Monday 07:00.
- Apply the behavior to every API key while preserving each key's existing
  provider and connection restrictions.
- Keep globally inactive connections inactive.
- Fall back independently for each API key when its weekend intersection is
  empty, including when quotas are exhausted, reset outside the window, or
  unavailable.
- Return to the exact base routing behavior at Monday 07:00 without rewriting
  persistent routing configuration.
- Expose an enabled-by-default emergency switch and effective status in the UI.

## Non-goals

- Changing routing for Codex, OpenRouter, or any provider other than Claude.
- Mutating global connection switches or saved API-key policies on a schedule.
- Optimizing model-specific Claude weekly windows in the first version. The
  eligibility decision uses the generic `weekly (7d)` quota.
- Sending traffic merely to consume quota; the feature only filters normal
  Claude requests.
- Replacing the existing provider fallback, rotation, cooldown, or retry logic.

## Terminology

- **Base set**: the Claude connections allowed before this feature, after the
  global `isActive` filter and the current API-key connection policy.
- **Weekend window**: Saturday 00:00 inclusive through Monday 07:00 exclusive,
  evaluated in `Asia/Bangkok`.
- **Weekend eligible set**: globally active Claude connections whose last fresh
  generic weekly quota observation satisfies the eligibility rules below.
- **Effective set**: the set given to the existing Claude credential selector.

## Eligibility Rules

A globally active Claude OAuth connection is weekend eligible when all of the
following are true:

1. Its `weekly (7d)` quota exists.
2. Its numeric remaining quota is greater than zero. If only `used` and `total`
   are present, remaining is derived as `total - used`.
3. `resetAt` parses to a finite timestamp.
4. `resetAt` is after the request time.
5. `resetAt` is at or before the Monday 07:00 boundary that closes the current
   weekend window.
6. The successful quota observation is no older than 15 minutes.

Invalid, missing, expired, or unavailable quota data makes that connection
ineligible for the current snapshot. A cached reset timestamp is also checked
against the current request time, so a connection becomes ineligible as soon as
its reset passes even if the next scheduler tick has not run.

## Effective Routing Semantics

The overlay applies only when its setting is enabled and the current Bangkok
time is inside the weekend window.

For each API key and each Claude request:

```text
baseSet = globallyActiveClaudeConnections
          intersect savedApiKeyClaudeConnections (when configured)

candidateSet = baseSet intersect weekendEligibleSet

effectiveSet = candidateSet is non-empty ? candidateSet : baseSet
```

This fallback is deliberately per API key. If key A allows only connection A
and the global eligible set contains only connection B, key A continues with
connection A while a key that permits B uses the weekend filter. An API key
with no saved connection policy treats all globally active Claude connections
as its base set.

If the setting is disabled or the request time is outside the weekend window,
the overlay returns no additional restriction and existing routing remains
unchanged. Existing exclusions, model locks, preferred connection selection,
sticky/round-robin behavior, retries, and fallback run after the effective set
has been resolved.

## Architecture

### 1. Weekend window utility

Create a small pure module responsible for Bangkok calendar calculations. It
accepts an injected clock and returns:

- whether the time is inside the weekend window;
- the closing Monday 07:00 timestamp;
- the next scheduler boundary.

The implementation must use explicit `Asia/Bangkok` calendar semantics rather
than the host timezone. Tests pin all boundary values.

### 2. Claude weekend routing service

Add a server-side service, following the existing quota auto-ping scheduler
pattern, with one process-global state object:

```text
{
  generation,
  running,
  lastCompletedAt,
  connections: {
    connectionId: {
      eligible,
      reason,
      remaining,
      resetAt,
      observedAt
    }
  }
}
```

The service runs once at application startup and every 10 minutes. It prevents
overlapping ticks and publishes a completed immutable snapshot atomically. A
generation check prevents an older asynchronous refresh from replacing a newer
snapshot.

Each tick:

1. Reads the feature setting.
2. Stops after publishing an inactive status when disabled or outside the
   weekend window.
3. Loads globally active Claude OAuth connections.
4. Refreshes credentials through the existing usage route helper.
5. Fetches Claude usage sequentially to reduce Anthropic quota-endpoint 429s.
6. Evaluates the generic weekly quota and publishes the new snapshot.

The existing Claude usage cache remains in force. The weekend service adds its
own `observedAt` freshness rule. The Claude usage reader must expose whether a
result came from a successful upstream read, a fresh cache hit, or the existing
stale-on-error fallback, together with the original observation timestamp. A
stale-on-error result keeps its original timestamp and must not be re-stamped as
fresh by the weekend scheduler.

### 3. Request-time overlay resolver

Add a pure resolver that receives the API-key-derived allowed connection IDs,
the globally active Claude connections, the latest weekend snapshot, settings,
and the current time. It returns either:

- a non-empty `Set` of weekend-filtered IDs; or
- the original allowed set/null when the per-key intersection is empty or the
  overlay is inactive.

Claude credential selection calls this resolver before the existing connection
selection strategy. Non-Claude providers bypass it entirely.

### 4. Settings and startup

Persist a setting shaped as:

```json
{
  "claudeWeekendRouting": {
    "enabled": true
  }
}
```

Missing settings mean enabled, providing the requested default for existing
installations. Application initialization starts the scheduler idempotently.
Changing the setting reconfigures the scheduler immediately.

No scheduled snapshot of `isActive` or API-key policies is stored because
there is nothing to restore. On process restart during the weekend, requests
use their base sets until the first usable snapshot is published.

## API and UI

### Settings

Add a `Claude Weekend Routing` switch to Settings. The description states:

`Saturday 00:00 – Monday 07:00 (Asia/Bangkok)`

The switch is enabled by default and can be disabled immediately as an
operational escape hatch.

### Status endpoint

Expose a read-only authenticated status endpoint that returns:

- enabled and currentlyActive;
- weekend start/end timestamps;
- lastCompletedAt;
- per-connection eligibility reason, remaining percentage, resetAt, observedAt;
- whether the overall snapshot currently has eligible connections.

The endpoint may accept an API-key database ID (never the secret key value) to
return that key's `filtered` or `fallback` effective mode. The server resolves
the saved policy and performs the intersection; the browser does not receive
other keys' policies.

The endpoint must never return access tokens, refresh tokens, API keys, proxy
credentials, or raw upstream error bodies.

### Claude provider UI

The Claude connection list displays one of:

- `Weekend eligible`
- `Weekly exhausted`
- `Resets after window`
- `Quota unavailable`
- `Weekend mode inactive`

In API-key view, the page also indicates whether that key is using the filtered
weekend set or its original fallback set. These are effective-routing badges;
the existing global connection toggles continue to show the saved base state.

## Failure Handling

- A failure for one connection does not abort evaluation of other connections.
- Authentication refresh or usage failures mark only that connection's quota
  unavailable.
- If a key's effective weekend intersection is empty for any reason, routing
  falls back to that key's base set as explicitly required.
- Scheduler exceptions retain the last completed snapshot only until each
  observation reaches the 15-minute freshness limit.
- Before the first completed snapshot after startup, routing uses base sets.
- The request-time Bangkok window check always wins over stale scheduler state;
  Monday 07:00 cannot remain filtered because a timer was delayed.
- Logs contain connection IDs and reason codes, never credentials or raw token
  values.

## Concurrency and Performance

- Only one quota refresh tick runs at a time.
- Claude usage calls are sequential and reuse the existing five-minute cache.
- Routing performs set intersection only; it never calls the quota API on the
  request path.
- Snapshot publication is atomic and readers never mutate the shared object.
- Timers are unref'd and scheduler startup is idempotent for Next.js reloads.

## Testing

### Pure unit tests

- Bangkok boundaries: Friday, Saturday 00:00, Sunday, Monday 06:59:59, and
  Monday 07:00.
- Eligibility for positive/zero remaining quota, derived remaining, invalid
  reset time, reset before now, reset at/before/after the Monday boundary, and
  observations older than 15 minutes.
- Per-key intersection and per-key fallback behavior.
- Disabled setting and non-Claude bypass.

### Scheduler tests

- Startup tick and 10-minute scheduling.
- No overlapping ticks and stale generation protection.
- Partial usage failures and sequential processing.
- Credential refresh integration.
- Snapshot expiry and restart fallback.

### Routing integration tests

- Global inactive remains unavailable.
- Saved per-key connection restrictions remain authoritative.
- Different keys can simultaneously use filtered and fallback base sets.
- Claude retry/rotation never escapes the resolved effective set.
- Other providers are unchanged.

### API/UI tests

- Missing setting defaults to enabled.
- Toggle persistence and immediate reconfiguration.
- Status response redacts credentials.
- Connection badges and per-key filtered/fallback state.

### Release verification

- Focused and regression Vitest suites.
- ESLint on touched files.
- Production build with an isolated `DATA_DIR`.
- Isolated browser verification across Settings, Claude Global view, and an
  API-key-specific Claude view.
- Clock-controlled verification of the Monday 07:00 transition without
  changing the host clock.

## Acceptance Criteria

1. During the Bangkok weekend window, a key with one or more eligible Claude
   connections routes only through its eligible intersection.
2. A key with an empty eligible intersection uses its exact original Claude
   base set.
3. Globally inactive connections are never re-enabled by the overlay.
4. Other providers behave exactly as before.
5. At Monday 07:00 the resolver produces the same Claude allowed set as it would
   with the feature disabled.
6. Neither global `isActive` values nor API-key provider/connection policies are
   changed by scheduler ticks or boundary transitions.
7. The setting defaults to enabled and can stop the overlay immediately.
8. UI status explains effective eligibility/fallback without exposing secrets.

## Rollout and Observability

- Ship enabled by default as requested, with the Settings switch as rollback.
- Log scheduler start/end, duration, counts by eligibility reason, and whether
  any connection was eligible.
- Do not log account names or quota payloads by default.
- Keep the existing database backup/restart procedure for deployment; this
  design requires only a settings value and no destructive migration.
