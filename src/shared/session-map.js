/**
 * Pure session-map helpers shared by the CLI process and the HTTP server.
 * No filesystem or path policy — callers own I/O and path sanitization.
 */

const LEGACY_WORKSPACE_KEY = "__legacy__";

/**
 * Expand a per-agent session-map entry into a byWorkspace table.
 * Supports:
 * - new: { byWorkspace: { [workspaceKey]: { sessionId, updatedAt } } }
 * - old: { sessionId, workspaceKey?, updatedAt? }
 */
function getByWorkspaceMap(entry) {
  if (!entry || typeof entry !== "object") return {};

  if (
    entry.byWorkspace &&
    typeof entry.byWorkspace === "object" &&
    !Array.isArray(entry.byWorkspace)
  ) {
    const out = {};
    for (const [key, value] of Object.entries(entry.byWorkspace)) {
      if (!key || !value || typeof value !== "object") continue;
      if (typeof value.sessionId !== "string" || !value.sessionId) continue;
      out[key] = {
        sessionId: value.sessionId,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
        ...(typeof value.providerKey === "string" && value.providerKey
          ? { providerKey: value.providerKey }
          : {}),
      };
    }
    // If byWorkspace is present but empty, still allow top-level legacy fields
    // only when they carry a sessionId (partial migration).
    if (Object.keys(out).length > 0) return out;
  }

  if (typeof entry.sessionId === "string" && entry.sessionId) {
    const key =
      typeof entry.workspaceKey === "string" && entry.workspaceKey
        ? entry.workspaceKey
        : LEGACY_WORKSPACE_KEY;
    return {
      [key]: {
        sessionId: entry.sessionId,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        ...(typeof entry.providerKey === "string" && entry.providerKey
          ? { providerKey: entry.providerKey }
          : {}),
      },
    };
  }

  return {};
}

/**
 * Resolve which provider session to resume for an agent in a workspace.
 * Returns "" when the workspace has no saved provider session (cold start).
 */
function isCompatibleSlot(slot, providerKey) {
  return !providerKey || !slot.providerKey || slot.providerKey === providerKey;
}

function resolveResumeSessionId(sessionMap, agent, workspaceKey, providerKey = "") {
  const entry = sessionMap && sessionMap[agent];
  if (!entry || typeof entry !== "object") return "";

  const byWorkspace = getByWorkspaceMap(entry);

  if (workspaceKey) {
    const direct = byWorkspace[workspaceKey];
    if (
      direct &&
      typeof direct.sessionId === "string" &&
      direct.sessionId &&
      isCompatibleSlot(direct, providerKey)
    ) {
      return direct.sessionId;
    }
    // Pre-workspaceKey legacy entries (no key stored) are only safe to resume
    // for base workspaces — never for worktree paths.
    if (workspaceKey.startsWith("base:") && byWorkspace[LEGACY_WORKSPACE_KEY]) {
      const legacySlot = byWorkspace[LEGACY_WORKSPACE_KEY];
      return isCompatibleSlot(legacySlot, providerKey) ? legacySlot.sessionId || "" : "";
    }
    return "";
  }

  // No workspace context: prefer last-written top-level field, then any slot.
  if (
    typeof entry.sessionId === "string" &&
    entry.sessionId &&
    isCompatibleSlot(entry, providerKey)
  ) {
    return entry.sessionId;
  }
  for (const slot of Object.values(byWorkspace)) {
    if (
      slot &&
      typeof slot.sessionId === "string" &&
      slot.sessionId &&
      isCompatibleSlot(slot, providerKey)
    ) {
      return slot.sessionId;
    }
  }
  return "";
}

/**
 * Upsert a provider session under agent → byWorkspace[workspaceKey].
 * Keeps top-level sessionId/workspaceKey as the most recently written slot
 * for debuggability and old readers.
 */
function upsertAgentProviderSession(
  sessions,
  agentKey,
  sessionId,
  workspaceKey = "",
  providerKey = ""
) {
  if (!sessions || typeof sessions !== "object") {
    throw new Error("sessions object is required");
  }
  if (!agentKey || !sessionId) return sessions;

  const prev =
    sessions[agentKey] && typeof sessions[agentKey] === "object" ? sessions[agentKey] : {};
  const byWorkspace = getByWorkspaceMap(prev);
  const updatedAt = new Date().toISOString();
  const slotKey = workspaceKey || LEGACY_WORKSPACE_KEY;
  byWorkspace[slotKey] = {
    sessionId,
    updatedAt,
    ...(providerKey ? { providerKey } : {}),
  };

  sessions[agentKey] = {
    sessionId,
    updatedAt,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(providerKey ? { providerKey } : {}),
    byWorkspace,
  };
  return sessions;
}

function providerKeyFromConfig(config = {}) {
  const providerId = config.providerId || config.name || "";
  return providerId && config.model ? `${providerId}:${config.model}` : providerId;
}

module.exports = {
  LEGACY_WORKSPACE_KEY,
  getByWorkspaceMap,
  resolveResumeSessionId,
  upsertAgentProviderSession,
  providerKeyFromConfig,
};
