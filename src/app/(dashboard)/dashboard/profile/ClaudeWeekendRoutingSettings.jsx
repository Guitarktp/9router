"use client";

import { useState } from "react";
import { Toggle } from "@/shared/components";

export default function ClaudeWeekendRoutingSettings({ settings, loading, onSaved }) {
  const [pendingEnabled, setPendingEnabled] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ type: "", message: "" });
  const savedEnabled = settings?.claudeWeekendRouting?.enabled !== false;
  const enabled = pendingEnabled ?? savedEnabled;

  const handleEnabledChange = async (nextEnabled) => {
    if (saving || loading) return;

    setPendingEnabled(nextEnabled);
    setSaving(true);
    setStatus({ type: "", message: "" });
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeWeekendRouting: { enabled: nextEnabled } }),
      });
      const saved = await response.json();
      if (!response.ok) {
        throw new Error(saved?.error || "Failed to update Claude weekend routing");
      }
      onSaved?.(saved);
      setStatus({
        type: "success",
        message: nextEnabled ? "Claude weekend routing enabled" : "Claude weekend routing disabled",
      });
    } catch (error) {
      setStatus({ type: "error", message: error.message || "Failed to update Claude weekend routing" });
    } finally {
      setPendingEnabled(null);
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 pt-4 border-t border-border/50">
      <div className="flex items-start sm:items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm sm:text-base">Claude Weekend Routing</p>
          <p className="text-xs sm:text-sm text-text-muted">
            Saturday 00:00 – Monday 07:00 (Asia/Bangkok)
          </p>
        </div>
        <Toggle
          checked={enabled}
          onChange={handleEnabledChange}
          disabled={loading || saving}
          aria-label="Enable Claude weekend routing"
        />
      </div>
      {status.message && (
        <p className={`text-xs sm:text-sm ${status.type === "error" ? "text-red-500" : "text-green-500"}`}>
          {status.message}
        </p>
      )}
    </div>
  );
}
