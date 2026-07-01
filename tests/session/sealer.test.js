const assert = require("node:assert/strict");
const test = require("node:test");
const sessionSealer = require("../../src/session/sealer");
const { STATE } = sessionSealer;

test("initial state is active with empty history", () => {
  const s = sessionSealer.makeSealer();
  assert.equal(s.getState(), STATE.ACTIVE);
  assert.equal(s.isActive(), true);
  assert.equal(s.isSealed(), false);
  assert.equal(s.isWarning(), false);
  assert.deepEqual(s.getHistory(), []);
  assert.equal(s.lastRatio(), 0);
});

test("update below warn threshold stays active", () => {
  const s = sessionSealer.makeSealer();
  assert.equal(s.update(0.5), STATE.ACTIVE);
  assert.equal(s.getState(), STATE.ACTIVE);
  assert.equal(s.lastRatio(), 0.5);
  assert.deepEqual(s.getHistory(), []);
});

test("update at warn threshold transitions to sealing", () => {
  const s = sessionSealer.makeSealer();
  assert.equal(s.update(0.86), STATE.SEALING);
  assert.equal(s.isWarning(), true);
  const hist = s.getHistory();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].from, STATE.ACTIVE);
  assert.equal(hist[0].to, STATE.SEALING);
  assert.equal(hist[0].ratio, 0.86);
});

test("update above action threshold from active goes directly to sealed", () => {
  const s = sessionSealer.makeSealer();
  assert.equal(s.update(0.95), STATE.SEALED);
  assert.equal(s.isSealed(), true);
  const hist = s.getHistory();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].from, STATE.ACTIVE);
  assert.equal(hist[0].to, STATE.SEALED);
});

test("sealing → sealed on action threshold", () => {
  const s = sessionSealer.makeSealer();
  s.update(0.86);
  assert.equal(s.update(0.91), STATE.SEALED);
  assert.equal(s.isSealed(), true);
  const hist = s.getHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[1].from, STATE.SEALING);
  assert.equal(hist[1].to, STATE.SEALED);
});

test("sealing → active on recovery (hysteresis)", () => {
  const s = sessionSealer.makeSealer();
  s.update(0.86);
  assert.equal(s.update(0.75), STATE.ACTIVE);
  const hist = s.getHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[1].from, STATE.SEALING);
  assert.equal(hist[1].to, STATE.ACTIVE);
});

test("sealing does NOT recover at ratio between recovery and warn", () => {
  const s = sessionSealer.makeSealer();
  s.update(0.86);
  // 0.82 is between recovery (0.80) and warn (0.85) — should stay sealing
  assert.equal(s.update(0.82), STATE.SEALING);
});

test("sealed is terminal — no further transitions", () => {
  const s = sessionSealer.makeSealer();
  s.update(0.95);
  assert.equal(s.getState(), STATE.SEALED);
  assert.equal(s.update(0.5), STATE.SEALED);
  assert.equal(s.update(0.99), STATE.SEALED);
  // Only the initial transition recorded
  assert.equal(s.getHistory().length, 1);
});

test("ignores non-numeric ratios", () => {
  const s = sessionSealer.makeSealer();
  assert.equal(s.update("0.9"), STATE.ACTIVE);
  assert.equal(s.update(NaN), STATE.ACTIVE);
  assert.equal(s.update(undefined), STATE.ACTIVE);
  assert.equal(s.update(null), STATE.ACTIVE);
});

test("custom thresholds override defaults", () => {
  const s = sessionSealer.makeSealer({
    warnThreshold: 0.7,
    actionThreshold: 0.8,
    recoveryThreshold: 0.6,
  });
  assert.equal(s.thresholds.warn, 0.7);
  assert.equal(s.thresholds.action, 0.8);
  assert.equal(s.thresholds.recovery, 0.6);
  assert.equal(s.update(0.75), STATE.SEALING);
  assert.equal(s.update(0.85), STATE.SEALED);
});

test("rejects invalid threshold configuration", () => {
  assert.throws(() => sessionSealer.makeSealer({ warnThreshold: 0.9, actionThreshold: 0.8 }));
  assert.throws(() => sessionSealer.makeSealer({ warnThreshold: 0.7, recoveryThreshold: 0.75 }));
});

test("getHistory returns a copy (not internal reference)", () => {
  const s = sessionSealer.makeSealer();
  s.update(0.9);
  const h1 = s.getHistory();
  h1.push({ fake: true });
  assert.equal(s.getHistory().length, 1, "internal history should not be mutated by caller");
});

test("lastRatio reflects the most recent update", () => {
  const s = sessionSealer.makeSealer();
  s.update(0.3);
  assert.equal(s.lastRatio(), 0.3);
  s.update(0.5);
  assert.equal(s.lastRatio(), 0.5);
  // After sealed, lastRatio still updates (we record the value, just don't transition)
  s.update(0.95);
  assert.equal(s.lastRatio(), 0.95);
  s.update(0.4);
  assert.equal(s.lastRatio(), 0.4);
  assert.equal(s.isSealed(), true, "stays sealed after ratio drops");
});
