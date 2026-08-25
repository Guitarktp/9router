import {
  GLOBAL_PROVIDER_VIEW,
  resolveProviderView,
} from "./providerViewContext";

function failedKeyContext(error) {
  return {
    ok: false,
    keys: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function loadProviderLandingKeyContext(fetchImpl = fetch) {
  try {
    const response = await fetchImpl("/api/keys", { cache: "no-store" });
    let payload;
    try {
      payload = await response.json();
    } catch {
      return failedKeyContext("API key context returned invalid JSON");
    }

    if (!response.ok) {
      return failedKeyContext(
        payload?.error?.message
          || payload?.error
          || `API key context request failed (${response.status})`,
      );
    }
    if (!Array.isArray(payload?.keys)) {
      return failedKeyContext("API key context response is invalid");
    }
    return { ok: true, keys: payload.keys, error: null };
  } catch (error) {
    return failedKeyContext(error);
  }
}

export function resolveProviderLandingViewState(requestedView, keyContext) {
  if (requestedView === GLOBAL_PROVIDER_VIEW) {
    return { selectedView: GLOBAL_PROVIDER_VIEW, keyContextUnavailable: false };
  }
  if (!keyContext?.ok) {
    return { selectedView: requestedView, keyContextUnavailable: true };
  }
  return {
    selectedView: resolveProviderView(requestedView, keyContext.keys),
    keyContextUnavailable: false,
  };
}
