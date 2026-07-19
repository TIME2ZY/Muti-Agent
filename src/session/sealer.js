// Three-state machine for session context health, modeled after cat-cafe-tutorials
// lesson 08 "Session Chain" — adapted to rotate the durable provider session
// after the usable context budget is exhausted.
//
// State transitions:
//   active   --(ratio >= warn)-->     sealing
//   active   --(ratio >= action)-->   sealed   (skip warning on large jumps)
//   sealing  --(ratio >= action)-->   sealed
//   sealing  --(ratio < recovery)-->  active   (recovery hysteresis)
//   sealed   --(terminal)-->          sealed
//
// Ratios are measured against usable context (physical window minus reserve):
//   warn      0.90  - start showing context-warning SSE events
//   action    1.00  - preserve the configured reserve and rotate the session
//   recovery  0.85  - if ratio drops below this while sealing, go back to active

const STATE = Object.freeze({
  ACTIVE: "active",
  SEALING: "sealing",
  SEALED: "sealed",
});

const DEFAULT_WARN = 0.9;
const DEFAULT_ACTION = 1.0;
const DEFAULT_RECOVERY = 0.85;

function makeSealer(opts = {}) {
  const warnThreshold = typeof opts.warnThreshold === "number" ? opts.warnThreshold : DEFAULT_WARN;
  const actionThreshold =
    typeof opts.actionThreshold === "number" ? opts.actionThreshold : DEFAULT_ACTION;
  const recoveryThreshold =
    typeof opts.recoveryThreshold === "number" ? opts.recoveryThreshold : DEFAULT_RECOVERY;

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
