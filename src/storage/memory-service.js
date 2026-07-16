const crypto = require("node:crypto");

function createMemoryService({
  storage,
  idFactory = crypto.randomUUID,
  clock = () => new Date(),
} = {}) {
  if (!storage?.memories || typeof storage.transaction !== "function") {
    throw new Error("Memory service requires storage with transactions and a memory repository.");
  }

  function capture(input) {
    const threadId = requiredString(input?.threadId, "thread id");
    const captureKey = requiredString(input?.captureKey, "memory capture key");

    try {
      return storage.transaction(() => {
        const existing = storage.memories.getByCaptureKey(threadId, captureKey);
        if (existing) return { memory: existing, created: false, superseded: [] };

        const id = input.id || idFactory();
        const supersessionKey = nullableString(input.supersessionKey);
        const previous = supersessionKey
          ? storage.memories.listActiveBySupersessionKey(threadId, supersessionKey)
          : [];
        const memory = storage.memories.create({
          ...input,
          id,
          threadId,
          captureKey,
          supersessionKey,
          status: "captured",
          createdAt: input.createdAt || nowIso(clock),
        });
        const supersededAt = nowIso(clock);
        for (const oldMemory of previous) {
          storage.memories.transition(oldMemory.id, "superseded", {
            supersededBy: memory.id,
            metadata: {
              ...(oldMemory.metadata || {}),
              supersededAt,
              supersededBy: memory.id,
            },
          });
        }
        return { memory, created: true, superseded: previous.map((item) => item.id) };
      });
    } catch (error) {
      if (isCaptureKeyConflict(error)) {
        const existing = storage.memories.getByCaptureKey(threadId, captureKey);
        if (existing) return { memory: existing, created: false, superseded: [] };
      }
      throw error;
    }
  }

  function listActive(threadId, options = {}) {
    const items = storage.memories.listActive(requiredString(threadId, "thread id"), options);
    const maxChars = normalizeMaxChars(options.maxChars);
    if (maxChars === null) return items;

    const selected = [];
    let usedChars = 0;
    for (const item of items) {
      const contentChars = item.content.length;
      if (usedChars + contentChars > maxChars) continue;
      selected.push(item);
      usedChars += contentChars;
    }
    return selected;
  }

  function confirm(id, audit = {}) {
    const confirmedBy = requiredString(audit.confirmedBy, "memory confirmer");
    const confirmationSource = requiredString(
      audit.confirmationSource,
      "memory confirmation source"
    );
    const existing = storage.memories.get(id);
    if (!existing) return null;
    assertTransitionAllowed(existing, "confirmed");
    const confirmedAt = audit.confirmedAt || nowIso(clock);
    storage.memories.transition(id, "confirmed", {
      metadata: {
        ...(existing.metadata || {}),
        confirmedBy,
        confirmedAt,
        confirmationSource,
      },
    });
    return storage.memories.get(id);
  }

  function invalidate(id, audit = {}) {
    const existing = storage.memories.get(id);
    if (!existing) return null;
    assertTransitionAllowed(existing, "invalidated");
    storage.memories.transition(id, "invalidated", {
      metadata: {
        ...(existing.metadata || {}),
        invalidatedBy: requiredString(audit.invalidatedBy, "memory invalidator"),
        invalidatedAt: audit.invalidatedAt || nowIso(clock),
        invalidationReason: nullableString(audit.reason),
      },
    });
    return storage.memories.get(id);
  }

  return { capture, listActive, confirm, invalidate };
}

function assertTransitionAllowed(memory, nextStatus) {
  if (memory.status === nextStatus) return;
  if (new Set(["superseded", "invalidated"]).has(memory.status)) {
    throw new Error(`Cannot transition retired memory ${memory.id} from ${memory.status}.`);
  }
  if (nextStatus === "confirmed" && memory.status !== "captured") {
    throw new Error(`Cannot confirm memory ${memory.id} from ${memory.status}.`);
  }
}

function nowIso(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Memory service clock must return a valid Date.");
  }
  return value.toISOString();
}

function isCaptureKeyConflict(error) {
  return (
    error?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    String(error.message || "").includes("memory_entries.thread_id") &&
    String(error.message || "").includes("memory_entries.capture_key")
  );
}

function normalizeMaxChars(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("maxChars must be a non-negative number.");
  }
  return Math.floor(number);
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { createMemoryService };
