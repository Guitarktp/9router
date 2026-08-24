# API-Key-Specific Provider Routing Design

## Goal

Allow each endpoint API key to select its own active LLM providers while
preserving 9router's current behavior for existing keys, local mode, provider
connections, account selection, quota handling, combo fallback, and model
translation.

The Providers dashboard continues to show the complete provider catalog and
global connection state. A new view selector lets the operator switch from the
existing global connection controls to a selected API key's routing controls.

## Current Behavior

Endpoint API keys currently contain identity and activation fields only. The
gateway validates a key as a boolean when `requireApiKey` is enabled, then
selects the provider entirely from the requested model. The selected endpoint
key does not influence direct-provider routing, combo expansion, capacity
adapters, or the model list.

The Providers dashboard currently controls global provider connections. Its
card toggle disables or enables every connection for a provider and is not
related to endpoint API keys.

## Product Decisions

- One API key can have multiple active providers.
- Existing keys and newly created keys start with all current providers active.
- A key continues to authenticate and otherwise behave as it does today.
- A direct request for an inactive provider fails with a clear error.
- A combo filters inactive providers, then runs its existing fallback or fusion
  strategy over the remaining models.
- After a key is customized, providers introduced by a later 9router upgrade
  remain inactive for that key until explicitly enabled.
- At least one provider must remain active for a customized key. Operators use
  the existing API-key `isActive` control when they want to disable the key
  entirely.
- Provider toggles save immediately. A failed save rolls the UI back and shows
  an error notification.
- Per-key provider routing is a routing preference, not a security boundary in
  local mode. Enforced API-key authentication still depends on
  `requireApiKey`.

## Scope

This feature covers the LLM providers shown on the main Providers dashboard
and the model-routing paths served through the chat gateway, including OpenAI
Chat Completions and Responses, Anthropic Messages, and Gemini-compatible
requests. A request to `/v1/models` with a recognized active endpoint key also
returns only models belonging to providers active for that key.

The following remain unchanged:

- Provider credentials and connections.
- Connection-level active state, account selection, quota tracking, retries,
  cooldowns, and credential fallback.
- Combo definitions and global/combo-specific fallback strategies.
- Media Providers and their embedding, image, audio, search, fetch, video, and
  music handlers.
- Proxy Pools and other system-wide routing configuration.
- Requests in local mode that do not identify a recognized active endpoint
  key.

## Data Model

Add a nullable `TEXT` column named `activeProviders` to the `apiKeys` table.
The value is either SQL `NULL` or a JSON array of canonical provider IDs.

### Semantics

- `NULL` means the key has never been customized. Every current LLM provider is
  active, including providers added in later versions.
- A JSON array means the key has been customized. Only IDs in the array are
  active. Providers added in later versions are not implicitly added.
- An empty array is invalid. The API and repository layer reject it.
- Provider aliases are never stored. Values are normalized to canonical
  provider IDs before validation and persistence.
- Stale IDs left by a removed provider do not grant access. Reads intersect the
  stored array with the current provider catalog; the next successful update
  persists the normalized current set.
- If provider removal leaves a customized key with no current providers, the
  key remains restricted and LLM requests fail with the empty-provider 403
  until an operator enables a current provider. The dashboard must allow this
  recovery even though normal updates cannot create an empty list.

The first time an operator changes a `NULL` key, the dashboard materializes a
snapshot of all current LLM provider IDs, applies the requested toggle, and
sends the resulting non-empty array. This is the transition from inherited
"all providers" behavior to an explicit stable allowlist.

### Provider Catalog

Create one small catalog helper that returns the canonical LLM provider IDs
available for key routing. It combines visible registry providers with dynamic
OpenAI-compatible and Anthropic-compatible provider nodes shown on the main
Providers dashboard. The API validator and dashboard use the same catalog
semantics so a provider cannot be selectable in one layer and unknown in the
other.

### Migration and Backup

- Add the column to the central schema and bump `SCHEMA_VERSION`, causing the
  existing migration system to create a pre-schema backup.
- Existing rows receive `NULL`, preserving all-provider behavior.
- Extend backup export/import and database migration serialization so
  `activeProviders` round-trips as `NULL` or a JSON array.
- Parse malformed historical values defensively as `NULL` and log a warning;
  malformed data must not prevent startup.

## Repository and API Contract

`rowToKey` returns `activeProviders` as `null` or a normalized string array.
The API-key repository gains a lookup that returns the active key record rather
than a boolean-only validation result. Existing boolean validation remains
available for callers that only need authentication.

`GET /api/keys` and `GET /api/keys/:id` include `activeProviders`.

`PUT /api/keys/:id` continues to accept the existing `isActive` partial update
and additionally accepts:

```json
{
  "activeProviders": ["claude", "codex"]
}
```

The server validates that the field is an array, contains strings, resolves to
known canonical LLM providers, contains no duplicates after canonicalization,
and contains at least one provider. It returns the normalized updated key.
Aliases that collapse to the same canonical ID are duplicate input and are
rejected. Invalid input returns HTTP 400 without changing the stored
configuration.

## Routing Context

Introduce a focused routing-policy module rather than spreading allowlist
checks across handlers. It has three responsibilities:

1. Resolve the request's endpoint key into an authentication and routing
   context.
2. Answer whether a canonical provider is active for that context.
3. Filter model candidates by resolving each model to its canonical provider.

The context has one of two routing modes:

- `unrestricted`: preserve current all-provider routing.
- `restricted`: carry the endpoint key ID and a set of active provider IDs.

### Context Resolution

When `requireApiKey` is enabled, missing, unknown, inactive, or malformed keys
retain the current HTTP 401 behavior. A valid key produces unrestricted mode
when `activeProviders` is `NULL` and restricted mode when it contains an
explicit array.

When `requireApiKey` is disabled:

- No key produces unrestricted local mode, as today.
- A recognized active key applies its stored routing context.
- An unknown or inactive key preserves current unrestricted local-mode
  behavior. This feature does not silently turn optional local authentication
  into mandatory authentication.

Provider aliases and compatible-provider identifiers are normalized before a
policy decision. The endpoint key is loaded once near the request boundary and
the context is passed through routing calls; handlers do not repeatedly query
the database.

## Direct and Combo Routing

### Direct Models

After normal model resolution and before provider credential selection, the
final routing boundary checks the canonical provider against the key context.
An inactive provider returns HTTP 403 with the stable error code
`provider_not_active_for_api_key`. The message names the provider and the key's
display name without exposing the full key value.

An active provider continues through the existing credential selection,
refresh, quota, retry, translation, and streaming path unchanged.

### Combos

For combo requests, resolve every candidate model to its canonical provider
and remove candidates that are inactive for the selected key. Preserve model
order and duplicates exactly as the existing combo strategy expects.

- One or more remaining models: invoke the existing fallback, sticky rotation,
  or fusion behavior with only those models.
- No remaining models: return HTTP 403 with
  `no_active_combo_providers_for_api_key` before consuming rotation state or
  selecting credentials.

Capacity-adapter candidates are filtered by the same policy after augmentation.
The final single-model guard remains in place as defense in depth for nested
combos, aliases, adapter models, and fusion judge models. No internal model may
bypass the selected key's active-provider set.

## Model Listing

`GET /v1/models` resolves the optional endpoint key using the same context.
Restricted contexts filter provider-backed models before building the response.
Unrestricted contexts retain the current complete model list. Combo names may
remain visible when at least one of their constituent models is active; combos
with no active candidates are omitted.

This prevents clients from advertising direct models or unusable combos that
the same key would immediately reject.

## Dashboard Design

Add a `View` selector above the provider groups on the existing Providers page.
Its first option is `Global connections`, followed by endpoint keys identified
by display name and a masked suffix. Disabled endpoint keys remain selectable
for configuration and show a disabled badge.

### Global Connections Mode

This is the default every time the page opens. The page behaves exactly as it
does now:

- All provider groups, search, add-compatible actions, test actions, badges,
  links, and ordering remain unchanged.
- Existing card toggles continue to control provider connections.
- No endpoint-key routing state is modified.

### API-Key Routing Mode

Selecting a key keeps the same provider groups and cards but changes the card
toggle meaning to `Active for this API key`:

- The toggle is always visible and labeled through title/ARIA text.
- Connection badges still show global `Connected`, `Error`, `Disabled`, or
  `No connections` state independently of the key toggle.
- A provider with no current connection can remain active for a key. If a
  connection is added later, the key can use it without another routing edit.
- The toolbar shows `N of M active` across the full current routing catalog,
  independent of search filtering or the API-key provider group's collapsed
  `Show all` state.
- Card navigation to provider details remains unchanged; the toggle prevents
  link navigation when clicked.

For a `NULL` key, every current card initially appears active. The first toggle
creates the explicit snapshot described in the data-model section.

### Autosave and Failure Handling

Toggles update optimistically and send `PUT /api/keys/:id`. On success, the
normalized server response replaces local state and a compact success toast is
shown. On network failure or non-2xx response, the card rolls back to its prior
state and an error toast explains that no change was saved.

The UI prevents turning off the last active provider and directs the operator
to disable the endpoint key instead. The server enforces the same invariant to
protect non-UI callers and concurrent updates.

## Error Behavior

| Scenario | Result |
| --- | --- |
| Required key missing or invalid | Existing HTTP 401 behavior |
| Direct provider inactive for recognized key | HTTP 403 `provider_not_active_for_api_key` |
| Combo has no active provider candidates | HTTP 403 `no_active_combo_providers_for_api_key` |
| `activeProviders` is not an array or contains unknown IDs | HTTP 400 `invalid_active_providers` |
| Attempt to store zero active providers | HTTP 400 `at_least_one_provider_required` |
| Active provider has no usable credentials | Existing no-credentials response |
| Dashboard save fails | Roll back optimistic state and show error toast |

Error responses continue to use 9router's existing format-aware response
helpers so OpenAI- and Anthropic-compatible clients receive their expected
envelope.

## Testing Strategy

Use test-driven development with focused coverage at each boundary.

### Database and Migration

- Existing schema upgrades add the nullable column and trigger a schema backup.
- Existing rows deserialize with `activeProviders: null`.
- Explicit arrays serialize and deserialize without alias drift.
- Backup export/import preserves `NULL` and explicit lists.
- Malformed persisted JSON degrades to inherited all-provider mode without
  preventing startup.

### Repository and API

- Creation defaults to `NULL`.
- Partial `isActive` updates do not overwrite provider configuration.
- Valid lists are normalized and persisted.
- Empty, malformed, duplicate-only, and unknown-provider inputs are rejected
  atomically.
- Dynamic compatible-provider IDs are accepted only while present in the
  provider catalog.

### Routing Policy and Handlers

- Unrestricted contexts preserve direct and combo behavior.
- Direct active providers pass; inactive providers return the stable 403.
- Aliases resolve before checking.
- Combos retain order while removing inactive-provider candidates.
- An empty filtered combo returns the stable 403 without invoking credentials.
- Capacity adapters, nested combos, and fusion judge models cannot bypass the
  final guard.
- Optional local mode stays unrestricted without a recognized active key.
- Account fallback, quota, and streaming behavior remain unchanged after a
  provider passes policy.

### Model Listing

- Restricted keys see only active-provider direct models.
- Combos remain only when they have at least one active candidate.
- Existing and local-mode requests retain the complete list.

### Dashboard

- The page starts in Global connections mode and preserves current toggle
  behavior.
- Selecting a key renders the correct inherited or explicit active state.
- The first inherited-state toggle sends an explicit current-provider snapshot.
- Autosave success uses normalized server state.
- Autosave failure rolls back.
- The last active provider cannot be disabled.
- A stale customized key with zero current providers can recover by enabling
  any current provider.
- Search and all provider groups continue to work in both modes.

Run the focused suites first, then the existing project tests and production
build. Compare full-suite results with the known upstream baseline so unrelated
pre-existing failures are not attributed to this feature.

## Rollout and Compatibility

The migration is additive and defaults to existing behavior. Deployment does
not require operators to edit current keys. The new dashboard selector defaults
to Global connections, so existing provider administration remains familiar.

If the custom branch is later rebased onto upstream, conflicts should be
limited to the API-key schema/repository, request routing boundary, model list,
and Providers page. The routing policy and provider-catalog helpers remain
small isolated units to reduce merge risk.

## Acceptance Criteria

1. Two active endpoint keys can route the same requested combo through different
   provider subsets without changing global provider connections.
2. Existing keys with no provider configuration pass all current regression
   scenarios unchanged.
3. Direct inactive-provider requests and empty filtered combos return clear,
   stable 403 errors.
4. Active-provider combos preserve the current order, fallback/fusion strategy,
   account selection, and retry behavior for their remaining candidates.
5. The Providers dashboard defaults to its current global behavior and exposes
   an autosaving per-key provider view.
6. A customized key never activates a newly introduced provider automatically.
7. Database upgrade, backup/import, focused tests, full regression tests, and
   production build complete with no new failures.

## Non-Goals

- Per-key provider account or credential selection.
- Per-key model-level allowlists.
- Per-key quotas, rate limits, billing, or usage permissions.
- Reordering providers differently per key.
- Changing combo definitions or global provider availability.
- Applying this LLM-provider control to Media Providers.
