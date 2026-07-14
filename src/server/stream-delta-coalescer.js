/**
 * Coalesce high-frequency streaming deltas before durable sinks (transcript /
 * SQLite / in-memory invocation registry). Live SSE stays unbatched at the
 * call site — this helper only decides *what* to write, not what to emit.
 *
 * Coalesce kinds: text.delta, thinking.delta (independent buffers — Grok and
 * similar providers interleave the two streams; flushing on every kind switch
 * re-fragments recall).
 *
 * Trade-off: interleaved think/text may be written as two contiguous segments
 * in first-seen kind order (not micro-interleaved chronology). Prefer fewer
 * durable rows over strict token-level timeline fidelity.
 *
 * Flush when:
 *   - a buffer reaches maxChars
 *   - a buffer is idle for maxMs (timer resets on each append)
 *   - a non-delta / boundary event arrives
 *   - flushAll() is called (stream end, seal, stderr, …)
 */

const COALESCE_KINDS = new Set(["text.delta", "thinking.delta"]);

/**
 * Prefer one (or few) durable segment(s) per stream kind per turn. Mid-turn
 * recall still gets content via idle flush + end flush.
 */
const DEFAULT_MAX_CHARS = 8_000;
/** Idle debounce: keep merging while the stream is hot; flush after a pause. */
const DEFAULT_MAX_MS = 1_500;

/**
 * @param {object} options
 * @param {(kind: string, payload: object) => void} options.write
 *   Called for each durable event (coalesced or pass-through).
 * @param {boolean} [options.enabled=true]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxMs]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 */
function createStreamDeltaCoalescer(options = {}) {
  if (typeof options.write !== "function") {
    throw new Error("createStreamDeltaCoalescer requires options.write");
  }

  const write = options.write;
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(0, options.maxChars) : DEFAULT_MAX_CHARS;
  const maxMs = Number.isFinite(options.maxMs) ? Math.max(0, options.maxMs) : DEFAULT_MAX_MS;
  const enabled = options.enabled !== false && maxChars > 0;
  const schedule =
    typeof options.schedule === "function" ? options.schedule : (fn, ms) => setTimeout(fn, ms);
  const cancel =
    typeof options.cancel === "function" ? options.cancel : (handle) => clearTimeout(handle);

  /** @type {Map<string, { text: string, payload: object, timer: unknown }>} */
  const buffers = new Map();
  /** Open buffer kinds in first-seen order (preserves stream order on flushAll). */
  const openOrder = [];

  function clearTimer(buf) {
    if (buf.timer != null) {
      cancel(buf.timer);
      buf.timer = null;
    }
  }

  function removeOpen(kind) {
    const idx = openOrder.indexOf(kind);
    if (idx >= 0) openOrder.splice(idx, 1);
  }

  function flushKind(kind) {
    const buf = buffers.get(kind);
    if (!buf) return;
    clearTimer(buf);
    buffers.delete(kind);
    removeOpen(kind);
    if (!buf.text) return;
    write(kind, { ...buf.payload, text: buf.text });
  }

  function flushAll() {
    while (openOrder.length > 0) {
      flushKind(openOrder[0]);
    }
  }

  function ensureBuf(kind, basePayload) {
    let buf = buffers.get(kind);
    if (!buf) {
      buf = { text: "", payload: basePayload, timer: null };
      buffers.set(kind, buf);
      openOrder.push(kind);
    }
    return buf;
  }

  function armIdleTimer(kind, buf) {
    if (maxMs <= 0) return;
    clearTimer(buf);
    const scheduledKind = kind;
    buf.timer = schedule(() => {
      const current = buffers.get(scheduledKind);
      if (!current || current.timer == null) return;
      current.timer = null;
      flushKind(scheduledKind);
    }, maxMs);
  }

  function accept(event) {
    if (!event || typeof event !== "object") return;
    const kind = typeof event.type === "string" ? event.type : "";
    if (!kind) return;

    if (!enabled || !COALESCE_KINDS.has(kind)) {
      flushAll();
      write(kind, event);
      return;
    }

    const text = typeof event.text === "string" ? event.text : "";
    if (!text) return;

    // Keep thinking / text buffers independent. Interleaved streams (common on
    // Grok) must not force a flush on every switch — that was re-fragmenting
    // durable logs back into near-SSE granularity.
    const buf = ensureBuf(kind, event);
    buf.payload = event;
    buf.text += text;

    if (buf.text.length >= maxChars) {
      flushKind(kind);
      return;
    }

    armIdleTimer(kind, buf);
  }

  function pendingChars(kind) {
    if (kind) {
      const buf = buffers.get(kind);
      return buf ? buf.text.length : 0;
    }
    let total = 0;
    for (const buf of buffers.values()) total += buf.text.length;
    return total;
  }

  return {
    accept,
    flushAll,
    flushKind,
    pendingChars,
    get enabled() {
      return enabled;
    },
    get maxChars() {
      return maxChars;
    },
    get maxMs() {
      return maxMs;
    },
  };
}

/**
 * Resolve coalesce options from env. Set DURABLE_DELTA_COALESCE=0|false to disable.
 * Optional: DURABLE_DELTA_COALESCE_CHARS, DURABLE_DELTA_COALESCE_MS.
 */
function resolveCoalesceOptionsFromEnv(env = process.env) {
  const flag = String(env.DURABLE_DELTA_COALESCE ?? "1").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") {
    return { enabled: false };
  }
  const options = { enabled: true };
  if (env.DURABLE_DELTA_COALESCE_CHARS != null && env.DURABLE_DELTA_COALESCE_CHARS !== "") {
    const n = Number(env.DURABLE_DELTA_COALESCE_CHARS);
    if (Number.isFinite(n)) options.maxChars = n;
  }
  if (env.DURABLE_DELTA_COALESCE_MS != null && env.DURABLE_DELTA_COALESCE_MS !== "") {
    const n = Number(env.DURABLE_DELTA_COALESCE_MS);
    if (Number.isFinite(n)) options.maxMs = n;
  }
  return options;
}

module.exports = {
  COALESCE_KINDS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MS,
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
};
