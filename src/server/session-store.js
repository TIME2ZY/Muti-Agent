const fs = require("node:fs");
const path = require("node:path");

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeSession(id) {
  return {
    id,
    title: "",
    createdAt: new Date().toISOString(),
    messages: [],
    worktree: null,
    projectDir: "",
  };
}

function readSessions(sessionsFile) {
  if (!fs.existsSync(sessionsFile)) return { sessions: {}, lastSessionId: null };

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    if (Array.isArray(parsed.messages) && !parsed.sessions) {
      const migratedId = generateId();
      return {
        sessions: {
          [migratedId]: {
            ...makeSession(migratedId),
            title: "Migrated",
            messages: parsed.messages,
          },
        },
        lastSessionId: migratedId,
      };
    }
    return {
      sessions: parsed.sessions || {},
      lastSessionId: parsed.lastSessionId || null,
    };
  } catch {
    return { sessions: {}, lastSessionId: null };
  }
}

function writeSessions(sessionsFile, data) {
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  const tempFile = `${sessionsFile}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, sessionsFile);
}

function createSession(sessionsFile) {
  const data = readSessions(sessionsFile);
  const id = generateId();
  const session = makeSession(id);
  data.sessions[id] = session;
  data.lastSessionId = id;
  writeSessions(sessionsFile, data);
  return session;
}

function listSessions(sessionsFile) {
  const data = readSessions(sessionsFile);
  return Object.values(data.sessions)
    .map(({ id, title, createdAt, messages }) => ({
      id,
      title: title || "(空对话)",
      createdAt,
      messageCount: Array.isArray(messages) ? messages.length : 0,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getSession(sessionsFile, sessionId) {
  const data = readSessions(sessionsFile);
  return data.sessions[sessionId] || null;
}

function ensureSession(sessionsFile, sessionId) {
  const data = readSessions(sessionsFile);
  let session = data.sessions[sessionId];
  if (!session) {
    session = makeSession(sessionId);
    data.sessions[sessionId] = session;
    data.lastSessionId = sessionId;
    writeSessions(sessionsFile, data);
  }
  return session;
}

function setSessionProjectDir(sessionsFile, sessionId, projectDir) {
  const data = readSessions(sessionsFile);
  const session = data.sessions[sessionId];
  if (!session) return null;
  session.projectDir = projectDir || "";
  data.lastSessionId = sessionId;
  writeSessions(sessionsFile, data);
  return session;
}

function setSessionWorktree(sessionsFile, sessionId, worktree) {
  const data = readSessions(sessionsFile);
  const session = data.sessions[sessionId];
  if (!session) return null;
  session.worktree = worktree || null;
  data.lastSessionId = sessionId;
  writeSessions(sessionsFile, data);
  return session;
}

function deleteSession(sessionsFile, sessionId) {
  const data = readSessions(sessionsFile);
  if (!data.sessions[sessionId]) return false;
  delete data.sessions[sessionId];
  if (data.lastSessionId === sessionId) {
    const remaining = Object.keys(data.sessions);
    data.lastSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
  writeSessions(sessionsFile, data);
  return true;
}

function appendToSession(sessionsFile, sessionId, message, options = {}) {
  const allowCreate = options.allowCreate !== false;
  const data = readSessions(sessionsFile);
  let session = data.sessions[sessionId];

  if (!session) {
    if (!allowCreate) return null;
    session = makeSession(sessionId);
    data.sessions[sessionId] = session;
  }

  const msg = {
    id: generateId(),
    createdAt: new Date().toISOString(),
    ...message,
  };
  session.messages.push(msg);

  if (!session.title && message.role === "user" && message.content) {
    session.title = message.content.slice(0, 40).replace(/\n/g, " ");
  }

  data.lastSessionId = sessionId;
  writeSessions(sessionsFile, data);
  return session;
}

module.exports = {
  createSession,
  readSessions,
  writeSessions,
  listSessions,
  getSession,
  ensureSession,
  setSessionProjectDir,
  setSessionWorktree,
  deleteSession,
  appendToSession,
};
