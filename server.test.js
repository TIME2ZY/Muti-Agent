const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("./server");
const { parseA2AMentions } = require("./a2a-routing");
const callbacks = require("./callbacks");

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

async function withServer(options, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "invoke-server-test-"));
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("serves fixed agent list", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agents`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.agents.map((agent) => agent.id), ["architect", "forge", "sage", "reviewer"]);
  });
});

test("rejects unknown agent", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "unknown", prompt: "hello" }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /Unsupported agent/);
  });
});

test("streams child stdout and exit events", async () => {
  const calls = [];
  const child = createMockChild();

  await withServer(
    {
      spawnRunner(command, args) {
        calls.push({ command, args });
        process.nextTick(() => {
          child.stdout.write("hello");
          child.stderr.write("thinking");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "forge", prompt: "hello", resume: true }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, process.execPath);
      assert.equal(calls[0].args[0], "invoke-cli.js");
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "forge");
      assert.equal(calls[0].args[3], "--resume");
      assert.ok(calls[0].args[4].endsWith("hello"), `Expected last arg to end with "hello", got: ${calls[0].args[4].slice(-50)}`);
      assert.ok(calls[0].args[4].includes("APPLICATION SKILL"), "Expected augmented prompt to contain APPLICATION SKILL marker");
      assert.match(text, /event: stdout\ndata: \{"text":"hello"\}/);
      assert.match(text, /event: stderr\ndata: \{"text":"thinking"\}/);
      assert.match(text, /event: exit\ndata: \{"code":0,"signal":null\}/);
    }
  );
});

test("chat endpoint streams assistant chunks and persists to session", async () => {
  const calls = [];
  let capturedSessionId = null;

  await withServer(
    {
      spawnRunner(command, args) {
        calls.push({ command, args });
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("partial ");
          child.stdout.write("answer");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "sage", prompt: "hello", resume: true }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls[0].args[0], "invoke-cli.js");
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "sage");
      assert.equal(calls[0].args[3], "--resume");
      assert.ok(calls[0].args[4].includes("hello"), `Expected prompt to contain "hello", got: ${calls[0].args[4].slice(-50)}`);
      assert.ok(calls[0].args[4].includes("APPLICATION SKILL"), "Expected augmented prompt to contain APPLICATION SKILL marker");
      assert.ok(calls[0].args[4].includes("MCP 回调工具说明"), "Expected prompt to contain callback instructions");
      assert.match(text, /event: message\ndata: \{"agent":"sage","role":"assistant","text":"partial "\}/);
      assert.match(text, /event: message\ndata: \{"agent":"sage","role":"assistant","text":"answer"\}/);
      // Verify session event is emitted
      const sessionMatch = text.match(/event: session\ndata: \{"sessionId":"([^"]+)"\}/);
      assert.ok(sessionMatch, "Expected SSE session event with sessionId");
      capturedSessionId = sessionMatch[1];

      // Verify messages can be retrieved via /api/messages?sessionId=
      const historyResponse = await fetch(`${baseUrl}/api/messages?sessionId=${capturedSessionId}`);
      const history = await historyResponse.json();
      assert.equal(history.messages.length, 2);
      assert.equal(history.messages[0].role, "user");
      assert.equal(history.messages[0].agent, "sage");
      assert.equal(history.messages[1].role, "assistant");
      assert.equal(history.messages[1].content, "partial answer");
    }
  );
});

test("chat endpoint rejects all agent mode", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("should not run");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "all", prompt: "compare" }),
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.match(body.error, /Unsupported agent/);
    }
  );
});

test("chat endpoint suppresses benign codex startup stderr", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stderr.write("Reading additional input from stdin...\n");
          child.stderr.write("2026-06-28T13:52:47.421934Z WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: maximum of 3 prompts is supported\n");
          child.stdout.write("answer");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "architect", prompt: "@Codex hello" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /"text":"answer"/);
      assert.doesNotMatch(text, /Reading additional input/);
      assert.doesNotMatch(text, /codex_core_plugins::manifest/);
      assert.doesNotMatch(text, /event: stderr/);
    }
  );
});

test("chat endpoint passes previous agent output to A2A-routed agent", async () => {
  const prompts = [];

  await withServer(
    {
      spawnRunner(command, args) {
        prompts.push(args[args.length - 1]);
        const child = createMockChild();
        process.nextTick(() => {
          if (args[2] === "architect") {
            child.stdout.write("@小智\n请继续实现。\narchitect result");
          } else {
            child.stdout.write("sage received");
          }
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "architect", prompt: "build feature" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(prompts.length, 2);
      assert.match(text, /event: a2a-route\ndata: \{"from":"architect","to":"sage"\}/);
      assert.match(prompts[1], /任务交接/);
      assert.match(prompts[1], /architect result/);
      assert.match(prompts[1], /用户原始请求/);
      assert.match(prompts[1], /build feature/);
    }
  );
});

test("messages endpoint returns empty history when no sessions exist", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/messages`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.messages, []);
  });
});

test("frontend restores message spacer before showing empty state after clearing messages", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const lines = source.split(/\r?\n/);
  const failures = [];

  lines.forEach((line, index) => {
    if (!line.includes("messagesEl.replaceChildren();")) return;

    const nextLines = lines.slice(index + 1, index + 12);
    const showIndex = nextLines.findIndex((candidate) => candidate.includes("showEmpty();"));
    const ensureIndex = nextLines.findIndex((candidate) => candidate.includes("ensureSpacer();"));

    if (showIndex !== -1 && (ensureIndex === -1 || showIndex < ensureIndex)) {
      failures.push(index + 1);
    }
  });

  assert.deepEqual(failures, []);
});

// ── Session CRUD tests ─────────────────────────────────────────

test("POST /api/sessions creates a new session", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.ok(body.session.id, "session should have an id");
    assert.equal(body.session.title, "");
    assert.deepEqual(body.session.messages, []);
  });
});

test("GET /api/sessions lists all sessions", async () => {
  await withServer({}, async (baseUrl) => {
    // Create two sessions
    await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    await fetch(`${baseUrl}/api/sessions`, { method: "POST" });

    const response = await fetch(`${baseUrl}/api/sessions`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.sessions.length, 2);
    assert.ok(body.sessions[0].createdAt >= body.sessions[1].createdAt, "sorted newest first");
  });
});

test("GET /api/sessions/:id returns a specific session", async () => {
  await withServer({}, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    const { session } = await created.json();

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.session.id, session.id);
    assert.deepEqual(body.session.messages, []);
  });
});

test("GET /api/sessions/:id returns 404 for unknown session", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/nonexistent`);
    assert.equal(response.status, 404);
  });
});

test("DELETE /api/sessions/:id deletes a session", async () => {
  await withServer({}, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
    const { session } = await created.json();

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);

    // Verify it's gone
    const getResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`);
    assert.equal(getResponse.status, 404);
  });
});

test("DELETE /api/sessions/:id returns 404 for unknown session", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/nonexistent`, { method: "DELETE" });
    assert.equal(response.status, 404);
  });
});

test("POST /api/chat with explicit sessionId stores messages there", async () => {
  await withServer(
    {
      spawnRunner(command, args) {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("ok");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      // Create session first
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      // Chat into that session
      await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "architect", prompt: "hello", sessionId: session.id }),
      });

      // Verify messages are there
      const got = await fetch(`${baseUrl}/api/sessions/${session.id}`);
      const body = await got.json();
      assert.equal(body.session.messages.length, 2, "should have user + assistant messages");
      assert.equal(body.session.title, "hello", "title should be first user message");
    }
  );
});

test("POST /api/chat rejects invalid projectDir", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("should not run");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "architect",
          prompt: "hello",
          projectDir: path.join(os.tmpdir(), "definitely-missing-project-dir"),
        }),
      });
      const text = await response.text();

      assert.equal(response.status, 400);
      const body = JSON.parse(text);
      assert.match(body.error, /Directory not found/);
    }
  );
});

// ── A2A routing unit tests ────────────────────────────────────

test("parseA2AMentions routes @label and @id consistently", () => {
  assert.deepEqual(parseA2AMentions("@Codex 帮我 review", "sage"), ["architect"]);
  assert.deepEqual(parseA2AMentions("@architect 帮我 review", "sage"), ["architect"]);
  assert.deepEqual(parseA2AMentions("@小智 继续实现", "architect"), ["sage"]);
  assert.deepEqual(parseA2AMentions("@sage 继续实现", "architect"), ["sage"]);
});

test("parseA2AMentions filters self and code blocks", () => {
  assert.deepEqual(parseA2AMentions("@sage 帮我", "sage"), []);
  assert.deepEqual(parseA2AMentions("```\n@sage 帮我\n```\n@reviewer 看下", "architect"), ["reviewer"]);
});

test("parseA2AMentions caps at 2 targets", () => {
  const text = "@Codex 方案\n@小智 实现\n@小虎鲸 测试\n@M-M review";
  const mentions = parseA2AMentions(text, "architect");
  assert.equal(mentions.length, 2);
});

test("chat endpoint aborts previous invocation on same session", async () => {
  let callCount = 0;
  await withServer(
    {
      spawnRunner(command, args) {
        callCount += 1;
        const child = createMockChild();
        if (callCount === 1) {
          // Hold the first child open until it is killed by the second chat.
          child.kill = (sig) => {
            child.stderr.write(`killed:${sig}\n`);
            child.emit("close", null, sig);
            return true;
          };
        } else {
          // Second child finishes quickly so the test can complete.
          process.nextTick(() => {
            child.stdout.write("done");
            child.emit("close", 0, null);
          });
        }
        return child;
      },
    },
    async (baseUrl) => {
      // Create a session explicitly so both chats target the same id.
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      // Start first long-running chat.
      const first = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "architect", prompt: "long task", sessionId: session.id }),
      });
      assert.equal(first.status, 200);

      // Start second chat on the same session: it should abort the first.
      const second = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "sage", prompt: "new task", sessionId: session.id }),
      });
      assert.equal(second.status, 200);

      const text = await second.text();
      assert.match(text, /event: agent-start\ndata: \{"agent":"sage"\}/);
      assert.equal(callCount, 2);
    }
  );
});

// ── MCP callback tests ────────────────────────────────────────

test("callback post-message rejects invalid token", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/callbacks/post-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        invocationId: "invocation-1",
        callbackToken: "invalid",
        content: "hello",
      }),
    });
    assert.equal(response.status, 401);
  });
});

test("callbacks.postMessage persists, broadcasts, and enqueues A2A targets", () => {
  const sseEvents = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      sseEvents.push(chunk);
      return true;
    },
  };

  const sessionId = "session-cb-1";
  const worklist = ["architect"];
  const controller = new AbortController();
  const threadCtx = {
    res: fakeRes,
    worklist,
    controller,
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };

  const invocationId = "invocation-cb-1";
  const callbackToken = "token-cb-1";
  threadCtx.tokens.set(invocationId, { agentId: "architect", callbackToken });
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (file, sid, msg) => appended.push({ file, sid, msg });

  const ok = callbacks.postMessage(sessionId, invocationId, "@sage 请继续实现", {
    appendToSession: appendFn,
  });

  assert.equal(ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].msg.role, "assistant");
  assert.equal(appended[0].msg.agent, "architect");
  assert.equal(appended[0].msg.content, "@sage 请继续实现");
  assert.equal(worklist.includes("sage"), true);
  assert.equal(threadCtx.a2aCount, 1);

  const joined = sseEvents.join("");
  assert.match(joined, /event: message\ndata: \{"agent":"architect","role":"assistant","text":"@sage 请继续实现"\}/);
  assert.match(joined, /event: a2a-route\ndata: \{"from":"architect","to":"sage"\}/);

  callbacks.unregisterThread(sessionId);
});

test("callbacks.validateToken accepts only exact matches", () => {
  const sessionId = "session-vt-1";
  const invocationId = "invocation-vt-1";
  const callbackToken = "token-vt-1";
  const threadCtx = {
    tokens: new Map([[invocationId, { agentId: "architect", callbackToken }]]),
  };
  callbacks.registerThread(sessionId, threadCtx);

  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), true);
  assert.equal(callbacks.validateToken(sessionId, invocationId, "wrong"), false);
  assert.equal(callbacks.validateToken(sessionId, "missing", callbackToken), false);
  assert.equal(callbacks.validateToken("missing", invocationId, callbackToken), false);

  callbacks.unregisterThread(sessionId);
});
