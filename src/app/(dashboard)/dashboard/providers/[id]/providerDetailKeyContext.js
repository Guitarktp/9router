import {
  GLOBAL_PROVIDER_VIEW,
  resolveProviderView,
} from "../providerViewContext";

function failedKeyContext(error) {
  return {
    ok: false,
    keys: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function loadProviderDetailKeyContext(fetchImpl = fetch) {
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

export function resolveProviderDetailView(requestedView, keyContext) {
  if (requestedView === GLOBAL_PROVIDER_VIEW) return GLOBAL_PROVIDER_VIEW;
  if (!keyContext?.ok) return requestedView;
  return resolveProviderView(requestedView, keyContext.keys);
}
