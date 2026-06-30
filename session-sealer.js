// Three-state machine for session context health, modeled after cat-cafe-tutorials
// lesson 08 "Session Chain" — but simplified for v1 (no auto-spawning of new
// sessions; we just terminate the current chain when sealed).
//
// State transitions:
//   active   --(ratio >= warn)-->     sealing
//   active   --(ratio >= action)-->   sealed   (skip warning on large jumps)
//   sealing  --(ratio >= action)-->   sealed
//   sealing  --(ratio < recovery)-->  active   (recovery hysteresis)
//   sealed   --(terminal)-->          sealed
//
// Thresholds (fraction of context window):
//   warn      0.85  - start showing context-warning SSE events
//   action    0.90  - terminate the current invocation, mark session sealed
//   recovery  0.80  - if ratio drops below this while sealing, go back to active

const STATE = Object.freeze({
  ACTIVE: "active",
  SEALING: "sealing",
  SEALED: "sealed",
});

const DEFAULT_WARN = 0.85;
const DEFAULT_ACTION = 0.90;
const DEFAULT_RECOVERY = 0.80;

function makeSealer(opts = {}) {
  const warnThreshold = typeof opts.warnThreshold === "number" ? opts.warnThreshold : DEFAULT_WARN;
  const actionThreshold = typeof opts.actionThreshold === "number" ? opts.actionThreshold : DEFAULT_ACTION;
  const recoveryThreshold = typeof opts.recoveryThreshold === "number" ? opts.recoveryThreshold : DEFAULT_RECOVERY;

  if (!(warnThreshold < actionThreshold)) {
    throw new Error("warnThreshold must be less than actionThreshold");
  }
  if (!(recoveryThreshold < warnThreshold)) {
    throw new Error("recoveryThreshold must be less than warnThreshold");
  }

  let state = STATE.ACTIVE;
  const history = [];
  let lastRatio = 0;
  let updatedAt = Date.now();

  function update(ratio) {
    if (typeof ratio !== "number" || Number.isNaN(ratio)) return state;
    lastRatio = ratio;
    updatedAt = Date.now();

    if (state === STATE.SEALED) return state;

    const prev = state;
    if (ratio >= actionThreshold) {
      state = STATE.SEALED;
    } else if (ratio >= warnThreshold) {
      if (state === STATE.ACTIVE) state = STATE.SEALING;
    } else if (ratio < recoveryThreshold) {
      if (state === STATE.SEALING) state = STATE.ACTIVE;
    }

    if (prev !== state) {
      history.push({ ts: updatedAt, from: prev, to: state, ratio });
    }
    return state;
  }

  return {
    update,
    getState: () => state,
    getHistory: () => history.slice(),
    lastRatio: () => lastRatio,
    updatedAt: () => updatedAt,
    isSealed: () => state === STATE.SEALED,
    isWarning: () => state === STATE.SEALING,
    isActive: () => state === STATE.ACTIVE,
    thresholds: { warn: warnThreshold, action: actionThreshold, recovery: recoveryThreshold },
    STATE,
  };
}

module.exports = { makeSealer, STATE, DEFAULT_WARN, DEFAULT_ACTION, DEFAULT_RECOVERY };
