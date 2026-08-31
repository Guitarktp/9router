function createInitialState() {
  return {
    interval: null,
    running: false,
    rerunRequested: false,
    generation: 0,
    snapshot: Object.freeze({
      generation: 0,
      enabled: true,
      currentlyActive: false,
      lastCompletedAt: null,
      windowStartAt: null,
      windowEndAt: null,
      connections: Object.freeze({}),
    }),
  };
}

const state = (global.__claudeWeekendRouting ??= createInitialState());

export function getClaudeWeekendRoutingState() {
  return state;
}

export function getClaudeWeekendRoutingSnapshot() {
  return state.snapshot;
}
