import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/providers/shared.js", () => ({
  ANTHROPIC_API_VERSION: "2023-06-01",
}));

vi.mock("open-sse/services/usage/shared.js", () => ({
  U: () => ({
    oauthUrl: "https://claude.example.test/oauth/usage",
    orgUrl: "https://claude.example.test/organizations/{org_id}/usage",
    settingsUrl: "https://claude.example.test/settings",
  }),
  parseResetTime: (value) => value,
}));

const successfulUsageResponse = (utilization = 20) => ({
  ok: true,
  json: vi.fn().mockResolvedValue({
    five_hour: { utilization, resets_at: "2026-01-01T13:00:00.000Z" },
    seven_day: { utilization, resets_at: "2026-01-08T12:00:00.000Z" },
  }),
});

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("Claude usage observations", () => {
  let getClaudeUsage;
  let getClaudeUsageObservation;
  let proxyAwareFetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

    ({ proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js"));
    ({ getClaudeUsage, getClaudeUsageObservation } = await import("open-sse/services/usage/claude.js"));
  });

  it("records the time of a successful upstream quota response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(successfulUsageResponse());

    const observation = await getClaudeUsageObservation("test-token");

    expect(observation).toMatchObject({
      source: "upstream",
      stale: false,
      observedAt: "2026-01-01T12:00:00.000Z",
    });
    expect(observation.result.quotas["weekly (7d)"].remaining).toBe(80);
  });

  it("labels an unexpired successful quota response as cached", async () => {
    proxyAwareFetch.mockResolvedValueOnce(successfulUsageResponse());
    const first = await getClaudeUsageObservation("test-token");

    const cached = await getClaudeUsageObservation("test-token");

    expect(cached).toMatchObject({
      source: "cache",
      stale: false,
      observedAt: first.observedAt,
    });
    expect(cached.result.quotas["weekly (7d)"].remaining).toBe(80);
  });

  it("preserves the successful observation time when refresh fails", async () => {
    proxyAwareFetch.mockResolvedValueOnce(successfulUsageResponse());
    const first = await getClaudeUsageObservation("test-token");

    vi.setSystemTime(new Date(Date.parse(first.observedAt) + 300001));
    proxyAwareFetch
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    const stale = await getClaudeUsageObservation("test-token");

    expect(stale).toMatchObject({
      source: "stale",
      stale: true,
      observedAt: first.observedAt,
    });
    expect(stale.result.quotas["weekly (7d)"].remaining).toBe(80);
  });

  it("shares one upstream request between concurrent observations", async () => {
    const response = deferred();
    proxyAwareFetch.mockReturnValueOnce(response.promise);

    const first = getClaudeUsageObservation("test-token");
    const second = getClaudeUsageObservation("test-token");
    response.resolve(successfulUsageResponse());

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ source: "upstream", stale: false }),
      expect.objectContaining({ source: "upstream", stale: false }),
    ]);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("recovers after a thrown upstream fetch without retaining its in-flight promise", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("network unavailable"));

    const failed = await getClaudeUsageObservation("test-token");

    expect(failed).toMatchObject({ source: "upstream", stale: false, observedAt: null });
    expect(failed.result).toMatchObject({ message: expect.any(String) });

    proxyAwareFetch.mockResolvedValueOnce(successfulUsageResponse());
    const recovered = await getClaudeUsageObservation("test-token");

    expect(recovered).toMatchObject({ source: "upstream", stale: false });
    expect(recovered.result.quotas["weekly (7d)"].remaining).toBe(80);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps getClaudeUsage callers on the legacy usage result shape", async () => {
    proxyAwareFetch.mockResolvedValueOnce(successfulUsageResponse());

    const usage = await getClaudeUsage("test-token");

    expect(usage.quotas["weekly (7d)"].remaining).toBe(80);
    expect(usage).not.toHaveProperty("result");
    expect(usage).not.toHaveProperty("observedAt");
    expect(usage).not.toHaveProperty("source");
    expect(usage).not.toHaveProperty("stale");
  });
});
