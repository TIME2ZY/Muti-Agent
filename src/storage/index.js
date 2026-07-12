const { openMemoryDatabase, withTransaction } = require("./database");
const { createInvocationRepository } = require("./invocation-repository");
const { createMemoryRepository } = require("./memory-repository");
const { createMessageRepository } = require("./message-repository");
const { createRecallRepository } = require("./recall-repository");
const { createThreadRepository } = require("./thread-repository");
const { createWindowRepository } = require("./window-repository");

function createStorage(options = {}) {
  const db = options.db || openMemoryDatabase(options);
  const recall = createRecallRepository(db);
  return {
    db,
    threads: createThreadRepository(db),
    windows: createWindowRepository(db),
    messages: createMessageRepository(db),
    invocations: createInvocationRepository(db),
    memories: createMemoryRepository(db, recall),
    recall,
    transaction(work) {
      return withTransaction(db, work);
    },
    close() {
      if (db.open) db.close();
    },
  };
}

module.exports = { createStorage, openMemoryDatabase, withTransaction };
