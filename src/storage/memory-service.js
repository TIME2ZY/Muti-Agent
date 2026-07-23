const crypto = require("node:crypto");
const {
  PRODUCT_KINDS,
  ALL_KINDS,
  ALL_STATUSES,
  ACTIVE_STATUSES,
  normalizeProductKind,
  buildSupersessionKey,
  buildProductCaptureKey,
  deriveTopicFromContent,
  slugifyTopic,
  parseSupersessionKey,
} = require("./memory-keys");

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

  /**
   * Product write path for decision / constraint / fact.
   * Always sets a stable supersessionKey so later writes replace active peers.
   */
  function createProduct(input = {}) {
    const threadId = requiredString(input.threadId, "thread id");
    const kind = normalizeProductKind(input.kind);
    const content = requiredString(input.content, "memory content");
    assertProductSourceAffinity(threadId, input);
    const requestedSupersessionKey =
      typeof input.supersessionKey === "string" && input.supersessionKey.trim()
        ? input.supersessionKey.trim()
        : null;
    const parsedSupersessionKey = requestedSupersessionKey
      ? parseSupersessionKey(requestedSupersessionKey)
      : null;
    if (requestedSupersessionKey && !parsedSupersessionKey) {
      throw new Error("Memory supersessionKey must be a valid kind:topic key.");
    }
    if (parsedSupersessionKey && parsedSupersessionKey.kind !== kind) {
      throw new Error(
        `Memory supersessionKey kind "${parsedSupersessionKey.kind}" does not match "${kind}".`
      );
    }
    const topic =
      typeof input.topic === "string" && input.topic.trim()
        ? slugifyTopic(input.topic)
        : parsedSupersessionKey
          ? slugifyTopic(parsedSupersessionKey.topic)
          : deriveTopicFromContent(content);
    const supersessionKey = buildSupersessionKey(kind, topic);
    const captureKey =
      typeof input.captureKey === "string" && input.captureKey.trim()
        ? input.captureKey.trim()
        : buildProductCaptureKey(kind, topic, idFactory);

    const outcome = capture({
      id: input.id,
      threadId,
      kind,
      content,
      sourceMessageId: input.sourceMessageId || null,
      sourceInvocationId: input.sourceInvocationId || null,
      createdBy: input.createdBy || "user",
      createdAt: input.createdAt,
      metadata: {
        ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}),
        source: "product",
        topic,
      },
      windowId: input.windowId || null,
      captureKey,
      supersessionKey,
    });
    return { ...outcome, topic, supersessionKey };
  }

  function assertProductSourceAffinity(threadId, input) {
    if (input.sourceMessageId) {
      const message = storage.messages?.get(input.sourceMessageId);
      if (!message) throw new Error(`Source message ${input.sourceMessageId} does not exist.`);
      if (message.threadId !== threadId) {
        throw new Error(`Source message ${input.sourceMessageId} belongs to another thread.`);
      }
    }
    if (input.sourceInvocationId) {
      const invocation = storage.invocations?.get(input.sourceInvocationId);
      if (!invocation) {
        throw new Error(`Source invocation ${input.sourceInvocationId} does not exist.`);
      }
      if (invocation.threadId !== threadId) {
        throw new Error(
          `Source invocation ${input.sourceInvocationId} belongs to another thread.`
        );
      }
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

  /**
   * List memories for management UI (active and/or historical).
   */
  function list(threadId, options = {}) {
    const id = requiredString(threadId, "thread id");
    const includeRetired = options.includeRetired !== false;
    const kinds = normalizeFilterList(options.kinds, ALL_KINDS);
    const statuses = normalizeFilterList(
      options.statuses,
      ALL_STATUSES,
      includeRetired ? ALL_STATUSES : ACTIVE_STATUSES
    );
    const limit = normalizeLimit(options.limit, 200);

    let items = storage.memories.listForThread(id);
    if (kinds.length > 0) items = items.filter((item) => kinds.includes(item.kind));
    if (statuses.length > 0) items = items.filter((item) => statuses.includes(item.status));

    // Newest first for management UI.
    items = items
      .slice()
      .sort((a, b) => {
        const byTime = String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        if (byTime !== 0) return byTime;
        return String(b.id).localeCompare(String(a.id));
      })
      .slice(0, limit);

    return items.map(enrichMemory);
  }

  function get(id) {
    const memory = storage.memories.get(id);
    return memory ? enrichMemory(memory) : null;
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
    return enrichMemory(storage.memories.get(id));
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
    return enrichMemory(storage.memories.get(id));
  }

  function enrichMemory(memory) {
    if (!memory) return null;
    const related = memory.supersessionKey
      ? storage.memories
          .listForThread(memory.threadId)
          .filter(
            (item) => item.supersessionKey === memory.supersessionKey && item.id !== memory.id
          )
          .map((item) => ({
            id: item.id,
            status: item.status,
            createdAt: item.createdAt,
            supersededBy: item.supersededBy,
          }))
      : [];
    return {
      ...memory,
      topic: parseSupersessionKey(memory.supersessionKey)?.topic || memory.metadata?.topic || null,
      related,
      isActive: ACTIVE_STATUSES.includes(memory.status),
      isProduct: PRODUCT_KINDS.includes(memory.kind),
    };
  }

  return {
    capture,
    createProduct,
    listActive,
    list,
    get,
    confirm,
    invalidate,
    PRODUCT_KINDS,
  };
}

function assertTransitionAllowed(memory, nextStatus) {
  if (memory.status === nextStatus) return;
  if (new Set(["superseded", "invalidated"]).has(memory.status)) {
    throw new Error(`Cannot transition retired memory ${memory.id} from ${memory.status}.`);
  }
  if (nextStatus === "confirmed" && memory.status !== "captured") {
    throw new Error(`Cannot confirm memory ${memory.id} from ${memory.status}.`);
  }
  if (
    nextStatus === "invalidated" &&
    !new Set(["captured", "confirmed"]).has(memory.status)
  ) {
    throw new Error(`Cannot invalidate memory ${memory.id} from ${memory.status}.`);
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

function normalizeLimit(value, fallback = 200) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(number), 1000));
}

function normalizeFilterList(value, allowed, defaultList = []) {
  if (value === undefined || value === null || value === "") return defaultList.slice();
  const raw = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
  const filtered = raw.filter((item) => allowed.includes(item));
  return filtered;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  return value;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { createMemoryService };
