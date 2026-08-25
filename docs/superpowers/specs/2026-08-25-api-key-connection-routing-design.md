# API-Key-Specific Provider Connection Routing Design

## Goal

Allow every endpoint API key to use a different subset of connections inside
each active LLM provider. Existing API keys must continue to use all globally
active connections until an operator explicitly customizes that provider for
the key.

This extends the existing API-key-specific provider routing feature. Provider
selection remains the outer policy; connection selection becomes the inner
policy applied before the existing rotation, quota, cooldown, retry, and
fallback behavior.

## Product Decisions

- A key with no connection policy for a provider inherits all globally active
  connections for that provider.
- Global connection activation is the master switch. A key cannot make a
  globally disabled connection eligible.
- A customized provider must retain at least one selected connection. To stop
  a key using the provider, the operator disables that provider for the key.
- The key policy only narrows the global connection set. It does not introduce
  key-specific priority, rotation strategy, proxy settings, credentials, or
  quota state.
- Global connection edits, deletion, status, cooldown, quota, and health remain
  shared system state.
- A stored selected connection that later becomes globally disabled remains in
  the key policy but is ineligible. If globally re-enabled, it becomes eligible
  for that key again.
- Missing or stale selected connection IDs are ignored fail-closed. An explicit
  policy never silently falls back to inherited global connections.

## Scope

This feature applies to the main LLM Providers dashboard and the request paths
covered by the existing API-key provider-routing context. Media Providers and
other system-wide connection consumers remain unchanged.

The existing behavior remains unchanged for:

- API keys whose connection policy is `NULL`.
- Providers absent from a key's connection-policy object.
- Requests in unrestricted local mode without a recognized active endpoint
  key.
- Global connection management and credential lifecycle operations.

## Data Model

Add a nullable `TEXT` column named `activeConnections` to `apiKeys`. Its value
is SQL `NULL` or a JSON object mapping canonical provider IDs to arrays of
provider-connection IDs.

```json
{
  "claude": ["connection-1", "connection-3"],
  "codex": ["connection-8"]
}
```

### Semantics

- SQL `NULL` means every provider inherits its globally active connections.
- A missing provider property also means that provider inherits its globally
  active connections.
- A non-empty array means the provider is customized and only those connection
  IDs may be considered.
- An empty array is invalid.
- Provider aliases are normalized to canonical IDs before persistence.
- Each connection ID must exist and belong to the mapped provider at write
  time.
- Duplicate connection IDs are invalid.
- Connection policy may remain stored for a provider that is inactive in the
  key's `activeProviders`; it has no effect until that provider is re-enabled.
- A stale stored ID does not make any other connection eligible. Reads and
  routing ignore it, while a subsequent successful update persists the current
  validated list.

### Migration and Backup

- Add the column to the central schema and bump `SCHEMA_VERSION`, triggering the
  existing pre-schema backup.
- Existing rows receive `NULL`, preserving current behavior.
- Extend database export/import and legacy migration serialization so the field
  round-trips as `NULL` or a JSON object.
- Parse malformed historical values defensively as `NULL` with a warning so a
  malformed row cannot prevent startup.

## Repository and API Contract

The API-key repository parses and returns `activeConnections` as `null` or a
normalized provider-to-connection mapping. Creation defaults it to `null`.

`GET /api/keys` and `GET /api/keys/:id` include `activeConnections`.

`PUT /api/keys/:id` accepts an `activeConnections` partial update alongside the
existing fields:

```json
{
  "activeConnections": {
    "claude": ["connection-1", "connection-3"]
  }
}
```

The API validates the full supplied mapping before updating anything:

- The value is `null` or a plain object.
- Every provider resolves to a known canonical LLM provider.
- Every value is a non-empty string array without duplicates.
- Every connection exists and belongs to that provider.
- A connection that is globally inactive cannot be newly added to a customized
  list. Previously selected connections that later become globally inactive
  may remain stored when updating unrelated providers.

The update returns the normalized complete key record. Invalid input returns
HTTP 400 and leaves the stored record unchanged. Client-side autosaves for the
same key are serialized to prevent a slower response overwriting a newer
selection.

Resetting one provider to inherited mode removes that provider property from
the object. If no customized provider properties remain, the stored column is
normalized back to SQL `NULL`.

## Routing Context and Credential Selection

The request-boundary routing context is extended with the selected API key's
connection policy. It continues to be loaded once per request and passed
through the routing path.

For a resolved canonical provider, the context returns one of:

- `inherit`: no connection allowlist is supplied to credential selection.
- `custom`: a `Set` of allowed connection IDs is supplied.

Credential eligibility is evaluated in this order:

1. The provider is active for the endpoint API key.
2. The connection is in the key's explicit allowlist, or the provider inherits
   global connections.
3. The connection is globally active.
4. Existing exclusion, model-lock, quota, cooldown, proxy, priority, sticky,
   and rotation rules run unchanged.

`getProviderCredentials` receives an optional allowed-connection set and
filters the globally active query result before selection. Retry attempts keep
the same allowlist and therefore cannot escape to a forbidden account.

If no eligible connection remains:

- Direct-provider routing returns the existing provider-unavailable response.
- Combo routing continues its existing fallback over other providers that are
  active for the key.
- The router never broadens an explicit connection policy to global
  inheritance.

No-auth virtual connections keep their existing behavior because they do not
represent configurable provider-connection rows.

## Dashboard Design

The Providers landing page keeps the existing `Global connections / API key`
view selector. Provider-card links preserve the selected context with a query
parameter:

```text
/dashboard/providers/claude?view=<api-key-id>
```

The provider detail page shows the same context selector.

### Global View

Global view remains unchanged. Operators may add, edit, delete, reorder, test,
configure proxies, and globally enable or disable connections.

### API-Key View

The connection panel adds a provider-level mode control:

- `Use Global`: the provider property is absent and all globally active
  connections are inherited.
- `Custom connections`: rows expose key-specific selection toggles.

In API-key view:

- Add, edit, delete, reorder, proxy, test, and global activation controls are
  hidden or disabled to prevent accidental global changes.
- Each row retains its global health and status badges.
- A globally disabled connection is visibly labeled `Globally disabled`; its
  saved key selection remains visible but cannot be changed to selected while
  globally disabled.
- The final selected connection cannot be deselected. The UI explains that the
  operator should disable the provider for the key instead.
- If the provider itself is inactive for the key, its saved connection policy
  remains viewable but a banner states that routing is disabled.
- Changes autosave immediately. Failed saves roll back to the last confirmed
  record and show an error notification.

The provider-detail page fetches the API-key list and materializes the selected
key's effective connection state. Navigating back to the Providers page
preserves the selected view parameter.

## Error Handling and Recovery

- Invalid API payloads return a stable HTTP 400 response without partial
  persistence.
- A stale explicit policy with no eligible connection reports provider
  unavailability instead of inheriting global connections.
- The dashboard warns when a customized provider has no currently eligible
  connection and offers `Use Global` or selection of another globally active
  connection as recovery.
- Disabling a global connection immediately removes it from eligibility for
  every key without rewriting key policies.
- Re-enabling the global connection restores eligibility for keys that retained
  it in their explicit policies.

## Verification

Automated coverage must include:

- Parser, normalization, persistence, schema migration, and export/import.
- API validation for malformed objects, unknown providers, duplicates,
  provider/connection mismatch, empty arrays, and globally inactive additions.
- Existing keys inheriting all globally active connections.
- Two API keys using disjoint connection subsets inside the same provider.
- Global master disable and later re-enable behavior.
- Rotation, sticky selection, model locks, quota fallback, and retries never
  escaping the key allowlist.
- Explicit policies with stale or unavailable IDs failing closed.
- Combo fallback to a different allowed provider.
- UI helpers for inherited/custom state, last-selection protection, rollback,
  and query-context preservation.
- Focused test suites, lint for touched files, and a production build.

Manual verification uses two endpoint API keys configured with different
Claude connection subsets. Requests for the same model must report connection
IDs only from the corresponding key's subset, including after a forced retry.
