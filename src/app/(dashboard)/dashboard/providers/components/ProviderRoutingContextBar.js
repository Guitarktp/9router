import PropTypes from "prop-types";
import { GLOBAL_PROVIDER_VIEW } from "../apiKeyRoutingState";

function maskKey(value) {
  if (!value) return "••••";
  return `••••${value.slice(-4)}`;
}

export default function ProviderRoutingContextBar({
  apiKeys,
  selectedView,
  onChange,
  activeCount,
  totalCount,
}) {
  const isKeyView = selectedView !== GLOBAL_PROVIDER_VIEW;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <label
          htmlFor="provider-routing-view"
          className="text-xs font-medium text-text-muted"
        >
          View
        </label>
        <select
          id="provider-routing-view"
          value={selectedView}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-10 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none transition-colors focus:border-primary sm:max-w-md"
        >
          <option value={GLOBAL_PROVIDER_VIEW}>Global connections</option>
          {apiKeys.map((key) => (
            <option key={key.id} value={key.id}>
              {key.name || "Unnamed key"} · {maskKey(key.key)}
              {key.isActive ? "" : " · Disabled"}
            </option>
          ))}
        </select>
      </div>
      {isKeyView && (
        <p className="shrink-0 text-sm font-medium text-text-muted">
          {activeCount} of {totalCount} active
        </p>
      )}
    </div>
  );
}

ProviderRoutingContextBar.propTypes = {
  apiKeys: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
      key: PropTypes.string,
      isActive: PropTypes.bool,
    }),
  ).isRequired,
  selectedView: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  activeCount: PropTypes.number.isRequired,
  totalCount: PropTypes.number.isRequired,
};
