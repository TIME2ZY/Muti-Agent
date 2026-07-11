function createInvocationRegistry({ file, readFile, writeFile, logger = console }) {
  const events = new Map();
  for (const [id, record] of Object.entries(readFile(file))) {
    if (record && record.invocationId && record.sessionId) events.set(id, record);
  }

  function persist() {
    try {
      writeFile(file, Object.fromEntries(events));
    } catch (error) {
      logger.error("Failed to persist invocations:", error.message);
    }
  }

  function deleteForSession(sessionId) {
    let changed = false;
    for (const [id, record] of events) {
      if (record.sessionId === sessionId) {
        events.delete(id);
        changed = true;
      }
    }
    if (changed) persist();
  }

  return { events, persist, deleteForSession };
}

module.exports = { createInvocationRegistry };
