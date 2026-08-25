export const GLOBAL_PROVIDER_VIEW = "global";

export function buildProviderDetailHref(providerId, selectedView) {
  const base = `/dashboard/providers/${encodeURIComponent(providerId)}`;
  return selectedView === GLOBAL_PROVIDER_VIEW
    ? base
    : `${base}?view=${encodeURIComponent(selectedView)}`;
}

export function resolveProviderView(rawView, apiKeys) {
  return apiKeys.some((key) => key.id === rawView)
    ? rawView
    : GLOBAL_PROVIDER_VIEW;
}
