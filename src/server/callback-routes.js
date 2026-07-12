function validateOptionalCallbackAuth({
  sessionId,
  invocationId,
  callbackToken,
  callbacks,
  sendJson,
  res,
}) {
  if (!(invocationId || callbackToken)) return true;
  if (!invocationId || !callbackToken) {
    sendJson(res, 400, { error: "invocationId and X-Callback-Token must be provided together." });
    return false;
  }
  if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
    sendJson(res, 401, { error: "Invalid callback token." });
    return false;
  }
  return true;
}

function createCallbackRoutes({
  callbacks,
  transcript,
  appendToSession,
  getSession,
  sessionsFile,
  sendJson,
  readJsonBody,
  durableRecorder,
  recallService,
}) {
  const recall = recallService || transcript;
  return async function handleCallbackRoutes(req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/callbacks/post-message") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const invocationId = typeof body.invocationId === "string" ? body.invocationId : "";
      const callbackToken = typeof body.callbackToken === "string" ? body.callbackToken : "";
      const content = typeof body.content === "string" ? body.content : "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, { error: "sessionId, invocationId, and callbackToken are required." });
        return true;
      }
      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return true;
      }

      const postOptions = { appendToSession };
      if (durableRecorder) postOptions.durableRecorder = durableRecorder;
      const ok = callbacks.postMessage(sessionId, invocationId, content, postOptions);
      if (!ok) {
        sendJson(res, 410, { error: "Thread no longer active; message was not delivered." });
        return true;
      }

      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/thread-context") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";

      if (!sessionId || !invocationId || !callbackToken) {
        sendJson(res, 400, {
          error: "sessionId, invocationId, and X-Callback-Token are required.",
        });
        return true;
      }
      if (!callbacks.validateToken(sessionId, invocationId, callbackToken)) {
        sendJson(res, 401, { error: "Invalid callback token." });
        return true;
      }

      const session = getSession(sessionsFile, sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Session not found." });
        return true;
      }

      sendJson(res, 200, { messages: session.messages || [] });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/list-invocations") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (
        !validateOptionalCallbackAuth({
          sessionId,
          invocationId,
          callbackToken,
          callbacks,
          sendJson,
          res,
        })
      ) {
        return true;
      }

      const invocations = await recall.listInvocationsWithMeta(sessionId);
      sendJson(res, 200, { invocations });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/session-search") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";
      const query = url.searchParams.get("query") || "";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 20)) : 20;

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (!query) {
        sendJson(res, 400, { error: "query is required." });
        return true;
      }
      if (
        !validateOptionalCallbackAuth({
          sessionId,
          invocationId,
          callbackToken,
          callbacks,
          sendJson,
          res,
        })
      ) {
        return true;
      }

      const hits = await recall.searchTranscript(sessionId, query, { limit });
      sendJson(res, 200, { hits, query, limit });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/callbacks/read-invocation") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const invocationId = url.searchParams.get("invocationId") || "";
      const targetInvocationId = url.searchParams.get("targetInvocationId") || "";
      const callbackToken = req.headers["x-callback-token"] || "";
      const fromRaw = url.searchParams.get("from");
      const limitRaw = url.searchParams.get("limit");
      const from = fromRaw ? Math.max(0, parseInt(fromRaw, 10) || 0) : 0;
      const limit = limitRaw ? Math.max(1, Math.min(2000, parseInt(limitRaw, 10) || 200)) : 200;

      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required." });
        return true;
      }
      if (!targetInvocationId) {
        sendJson(res, 400, { error: "targetInvocationId is required." });
        return true;
      }
      if (
        !validateOptionalCallbackAuth({
          sessionId,
          invocationId,
          callbackToken,
          callbacks,
          sendJson,
          res,
        })
      ) {
        return true;
      }

      const result = await recall.readInvocationPage(sessionId, targetInvocationId, {
        from,
        limit,
      });
      if (result.total === 0) {
        sendJson(res, 404, { error: "Invocation not found." });
        return true;
      }

      sendJson(res, 200, { invocationId: targetInvocationId, ...result });
      return true;
    }

    return false;
  };
}

module.exports = {
  createCallbackRoutes,
};
