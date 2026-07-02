const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("../src/server/index");
const { parseA2AMentions } = require("../src/agents/routing");
const callbacks = require("../src/agents/callbacks");

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function createPassthroughWorktreeManager() {
  return {
    ensureWorktree({ baseDir, sessionId }) {
      return {
        sessionId,
        baseDir,
        worktreeDir: baseDir,
        branch: `codex/session-${sessionId}`,
        status: "active",
        createdAt: new Date().toISOString(),
      };
    },
    getStatus(sessionId) {
      return { sessionId, branch: `codex/session-${sessionId}`, clean: true, porcelain: [] };
    },
    getDiff() {
      return "";
    },
    discardWorktree(sessionId) {
      return { ok: true, sessionId };
    },
  };
}

async function withServer(options, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "invoke-server-test-"));
  const prevTranscriptDir = process.env.CAT_CAFE_TRANSCRIPT_DIR;
  if (!prevTranscriptDir) {
    process.env.CAT_CAFE_TRANSCRIPT_DIR = path.join(tmpDir, "transcripts");
  }
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    worktreeManager: options.worktreeManager || createPassthroughWorktreeManager(),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: path.join(tmpDir, "session-maps"),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (!prevTranscriptDir) {
      delete process.env.CAT_CAFE_TRANSCRIPT_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("serves fixed agent list", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agents`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.agents.map((agent) => agent.id), ["architect", "orchestrator", "planner", "coder", "frontend", "critic"]);
    // Every agent must surface a non-empty description so the UI can show it.
    for (const agent of body.agents) {
      assert.ok(agent.description && agent.description.length > 0, `Agent ${agent.id} missing description`);
    }
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
        body: JSON.stringify({ agent: "orchestrator", prompt: "hello" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, process.execPath);
      assert.equal(calls[0].args[0], "src/agents/invoke-cli.js");
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "orchestrator");
      assert.ok(calls[0].args[3].endsWith("hello"), `Expected last arg to end with "hello", got: ${calls[0].args[3]?.slice(-50)}`);
      assert.ok(calls[0].args[3].includes("APPLICATION SKILL"), "Expected augmented prompt to contain APPLICATION SKILL marker");
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
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-test", text: "partial " }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-test", text: "answer" }) + "\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello" }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls[0].args[0], "src/agents/invoke-cli.js");
      assert.equal(calls[0].args[1], "--agent");
      assert.equal(calls[0].args[2], "planner");
      assert.ok(calls[0].args[3].includes("hello"), `Expected prompt to contain "hello", got: ${calls[0].args[3]?.slice(-50)}`);
      assert.ok(calls[0].args[3].includes("APPLICATION SKILL"), "Expected augmented prompt to contain APPLICATION SKILL marker");
      assert.ok(calls[0].args[3].includes("MCP 回调工具说明"), "Expected prompt to contain callback instructions");
      assert.match(text, /event: message\ndata: \{"agent":"planner","role":"assistant","text":"partial "\}/);
      assert.match(text, /event: message\ndata: \{"agent":"planner","role":"assistant","text":"answer"\}/);
      // Verify session event is emitted
      const sessionMatch = text.match(/event: session\ndata: \{"sessionId":"([^"]+)"\}/);
      assert.ok(sessionMatch, "Expected SSE session event with sessionId");
      capturedSessionId = sessionMatch[1];

      // Verify messages can be retrieved via /api/messages?sessionId=
      const historyResponse = await fetch(`${baseUrl}/api/messages?sessionId=${capturedSessionId}`);
      const history = await historyResponse.json();
      assert.equal(history.messages.length, 2);
      assert.equal(history.messages[0].role, "user");
      assert.equal(history.messages[0].agent, "planner");
      assert.equal(history.messages[1].role, "assistant");
      assert.equal(history.messages[1].content, "partial answer");
    }
  );
});

test("chat endpoint emits canonical agent-event SSE frames", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(JSON.stringify({
            type: "run.started",
            agent: "planner",
            invocationId: "inv-1",
            provider: "opencode",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "text.delta",
            agent: "planner",
            invocationId: "inv-1",
            text: "hello ",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "progress.update",
            agent: "planner",
            invocationId: "inv-1",
            items: [{ text: "done", done: true }],
          }) + "\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello" }),
      });
      const text = await response.text();
      assert.match(text, /event: agent-event/);
      assert.match(text, /"type":"text.delta"/);
      assert.match(text, /"type":"progress.update"/);
    }
  );
});

test("chat history stores only assistant text reconstructed from text.delta", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(JSON.stringify({
            type: "run.started",
            agent: "planner",
            invocationId: "inv-2",
            provider: "opencode",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "thinking.delta",
            agent: "planner",
            invocationId: "inv-2",
            text: "inspect",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "text.delta",
            agent: "planner",
            invocationId: "inv-2",
            text: "final answer",
          }) + "\n");
          child.stdout.write(JSON.stringify({
            type: "run.finished",
            agent: "planner",
            invocationId: "inv-2",
            exitCode: 0,
            signal: null,
          }) + "\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello" }),
      });
      const sse = await response.text();
      const sid = sse.match(/"sessionId":"([^"]+)"/)[1];
      const history = await (await fetch(`${baseUrl}/api/messages?sessionId=${sid}`)).json();
      const assistant = history.messages.find((msg) => msg.role === "assistant");
      assert.equal(assistant.content, "final answer");
    }
  );
});

test("chat endpoint preserves raw stdout chunk boundaries in SSE message events", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-chunks", text: "line 1\n\n" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-chunks", text: "    code-ish indent\n" }) + "\n");
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-chunks", text: "- list item" }) + "\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello chunks" }),
      });
      const text = await response.text();

      assert.match(text, /event: message\ndata: \{"agent":"planner","role":"assistant","text":"line 1\\n\\n"\}/);
      assert.match(text, /event: message\ndata: \{"agent":"planner","role":"assistant","text":"    code-ish indent\\n"\}/);
      assert.match(text, /event: message\ndata: \{"agent":"planner","role":"assistant","text":"- list item"\}/);
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
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "architect", invocationId: "inv-answer", text: "answer" }) + "\n");
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
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "architect", invocationId: "inv-a2a-1", text: "@小谋\n请继续实现。\narchitect result" }) + "\n");
          } else {
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-a2a-2", text: "planner received" }) + "\n");
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
      assert.match(text, /event: a2a-route\ndata: \{"from":"architect","to":"planner"\}/);
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
  const source = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
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

test("DELETE /api/sessions/:id discards an attached worktree", async () => {
  const calls = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ baseDir, sessionId }) {
          calls.push(["ensure", sessionId]);
          return {
            sessionId,
            baseDir,
            worktreeDir: baseDir,
            branch: `codex/session-${sessionId}`,
            status: "active",
            createdAt: new Date().toISOString(),
          };
        },
        getStatus(sessionId) {
          return { sessionId, branch: `codex/session-${sessionId}`, clean: true, porcelain: [] };
        },
        getDiff() {
          return "";
        },
        discardWorktree(sessionId) {
          calls.push(["discard", sessionId]);
          return { ok: true, sessionId };
        },
      },
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("answer");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-delete-worktree-"));
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello", projectDir: baseDir, useWorktree: true }),
      });
      const text = await response.text();
      const sessionId = text.match(/"sessionId":"([^"]+)"/)[1];

      const deleted = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.deepEqual(calls, [
        ["ensure", sessionId],
        ["discard", sessionId],
      ]);
    }
  );
});

test("DELETE /api/sessions/:id returns 404 for unknown session", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/nonexistent`, { method: "DELETE" });
    assert.equal(response.status, 404);
  });
});

test("DELETE /api/sessions/:id does not let a still-running chat recreate the session", async () => {
  const spawned = [];

  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        child.closeNow = (code = 0, signal = null) => child.emit("close", code, signal);
        spawned.push(child);
        return child;
      },
    },
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      const chatPromise = fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "architect", prompt: "long task", sessionId: session.id }),
      }).then((res) => res.text());

      const deadline = Date.now() + 2000;
      while (spawned.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(spawned.length, 1);

      const deleted = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200);

      spawned[0].stdout.write("late answer");
      spawned[0].closeNow(0, null);
      await chatPromise;

      const getResponse = await fetch(`${baseUrl}/api/sessions/${session.id}`);
      assert.equal(getResponse.status, 404);
    }
  );
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

      // Chat into that session (consume body to wait for stream completion)
      const chatResp = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "architect", prompt: "hello", sessionId: session.id }),
      });
      await chatResp.text(); // drain SSE stream — ensures appendToSession ran

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

test("project endpoint stores projectDir per session and chat reuses the saved directory", async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "server-project-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "server-project-b-"));
  const cwds = [];

  await withServer(
    {
      spawnRunner(command, args, options) {
        cwds.push(options.cwd);
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("ok");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const createdA = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session: sessionA } = await createdA.json();
      const createdB = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session: sessionB } = await createdB.json();

      let response = await fetch(`${baseUrl}/api/project`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionA.id, dir: dirA }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirA);

      response = await fetch(`${baseUrl}/api/project`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionB.id, dir: dirB }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirB);

      response = await fetch(`${baseUrl}/api/project?sessionId=${encodeURIComponent(sessionA.id)}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirA);

      response = await fetch(`${baseUrl}/api/project?sessionId=${encodeURIComponent(sessionB.id)}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).dir, dirB);

      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello A", sessionId: sessionA.id }),
      });
      assert.equal(response.status, 200);
      await response.text();

      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "hello B", sessionId: sessionB.id }),
      });
      assert.equal(response.status, 200);
      await response.text();

      assert.deepEqual(cwds, [dirA, dirB]);
    }
  );
});

test("chat endpoint does not create a worktree by default", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-no-worktree-base-"));
  const calls = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree() {
          throw new Error("ensureWorktree should not be called for default chat runs");
        },
      },
      spawnRunner(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        const child = createMockChild();
        process.nextTick(() => {
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
        body: JSON.stringify({ agent: "planner", prompt: "@小谋 hello", projectDir: baseDir }),
      });
      await response.text();

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cwd, baseDir);
      assert.equal(calls[0].env.CAT_CAFE_WORKTREE, "0");
      assert.equal(calls[0].env.CAT_CAFE_BASE_DIR, baseDir);
      assert.equal(calls[0].env.CAT_CAFE_WORKTREE_DIR, baseDir);
      assert.equal(calls[0].env.CAT_CAFE_BRANCH, "");
    }
  );
});

test("chat endpoint creates and uses a session worktree as child cwd", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-worktree-session");
  const calls = [];
  const worktreeCalls = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ baseDir: requestedBaseDir, sessionId }) {
          worktreeCalls.push({ requestedBaseDir, sessionId });
          return {
            sessionId,
            baseDir,
            worktreeDir,
            branch: `codex/session-${sessionId}`,
            status: "active",
            createdAt: "2026-06-30T00:00:00.000Z",
          };
        },
      },
      spawnRunner(command, args, options) {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        const child = createMockChild();
        process.nextTick(() => {
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
        body: JSON.stringify({ agent: "planner", prompt: "@小谋 hello", projectDir: baseDir, useWorktree: true }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      const sessionId = text.match(/"sessionId":"([^"]+)"/)[1];
      assert.equal(worktreeCalls.length, 1);
      assert.equal(worktreeCalls[0].requestedBaseDir, baseDir);
      assert.equal(worktreeCalls[0].sessionId, sessionId);
      assert.equal(calls[0].cwd, worktreeDir);
      assert.equal(calls[0].env.CAT_CAFE_WORKTREE, "1");
      assert.equal(calls[0].env.CAT_CAFE_WORKTREE_DIR, worktreeDir);
    }
  );
});

test("chat endpoint reuses the session worktree on later turns", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-worktree-base-"));
  const worktreeDir = path.join(os.tmpdir(), "server-worktree-reuse");
  let ensureCount = 0;
  const cwds = [];

  await withServer(
    {
      worktreeManager: {
        ensureWorktree({ sessionId }) {
          ensureCount += 1;
          return {
            sessionId,
            baseDir,
            worktreeDir,
            branch: `codex/session-${sessionId}`,
            status: "active",
            createdAt: "2026-06-30T00:00:00.000Z",
          };
        },
      },
      spawnRunner(command, args, options) {
        cwds.push(options.cwd);
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write("ok");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      for (const prompt of ["first", "second"]) {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "planner", prompt, sessionId: session.id, projectDir: baseDir, useWorktree: true }),
        });
        assert.equal(response.status, 200);
        await response.text();
      }

      assert.equal(ensureCount, 1);
      assert.deepEqual(cwds, [worktreeDir, worktreeDir]);
    }
  );
});

test("worktree status, diff, and discard endpoints delegate to manager", async () => {
  const calls = [];
  await withServer(
    {
      worktreeManager: {
        getStatus(sessionId) {
          calls.push(["status", sessionId]);
          return { sessionId, branch: "codex/session-x", clean: false, porcelain: [" M server.js"] };
        },
        getDiff(sessionId) {
          calls.push(["diff", sessionId]);
          return "diff --git a/server.js b/server.js\n";
        },
        discardWorktree(sessionId) {
          calls.push(["discard", sessionId]);
          return { ok: true, sessionId };
        },
      },
    },
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      const statusResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/worktree/status`);
      assert.equal(statusResponse.status, 200);
      assert.equal((await statusResponse.json()).clean, false);

      const diffResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/worktree/diff`);
      assert.equal(diffResponse.status, 200);
      assert.match((await diffResponse.json()).diff, /diff --git/);

      const discardResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/worktree/discard`, { method: "POST" });
      assert.equal(discardResponse.status, 200);
      assert.equal((await discardResponse.json()).ok, true);

      assert.deepEqual(calls, [
        ["status", session.id],
        ["diff", session.id],
        ["discard", session.id],
      ]);
    }
  );
});

// ── A2A routing unit tests ────────────────────────────────────

test("parseA2AMentions routes @label and @id consistently", () => {
  assert.deepEqual(parseA2AMentions("@Codex 帮我 review", "planner"), ["architect"]);
  assert.deepEqual(parseA2AMentions("@architect 帮我 review", "planner"), ["architect"]);
  assert.deepEqual(parseA2AMentions("@小谋 继续实现", "architect"), ["planner"]);
  assert.deepEqual(parseA2AMentions("@planner 继续实现", "architect"), ["planner"]);
});

test("parseA2AMentions filters self and code blocks", () => {
  assert.deepEqual(parseA2AMentions("@planner 帮我", "planner"), []);
  assert.deepEqual(parseA2AMentions("```\n@planner 帮我\n```\n@critic 看下", "architect"), ["critic"]);
});

test("parseA2AMentions caps at 2 targets", () => {
  const text = "@Codex 方案\n@小谋 实现\n@万事通 测试\n@小评 review";
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
        body: JSON.stringify({ agent: "planner", prompt: "new task", sessionId: session.id }),
      });
      assert.equal(second.status, 200);

      const text = await second.text();
      assert.match(text, /event: agent-start\ndata: \{"agent":"planner","invocationId":"[^"]+"\}/);
      assert.equal(callCount, 2);
    }
  );
});

test("stale aborted chat cleanup does not unregister the replacement chat callbacks", async () => {
  const spawned = [];

  await withServer(
    {
      spawnRunner(command, args, options = {}) {
        const child = createMockChild();
        child.env = options.env;
        child.closeNow = (code = 0, sig = null) => child.emit("close", code, sig);
        child.kill = (sig) => {
          child.killedWith = sig;
          return true;
        };
        spawned.push(child);
        return child;
      },
    },
    async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/sessions`, { method: "POST" });
      const { session } = await created.json();

      const firstPromise = fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "architect", prompt: "old task", sessionId: session.id }),
      }).then((r) => r.text());

      const deadline1 = Date.now() + 2000;
      while (spawned.length < 1 && Date.now() < deadline1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(spawned.length, 1);

      const secondPromise = fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "replacement task", sessionId: session.id }),
      }).then((r) => r.text());

      const deadline2 = Date.now() + 2000;
      while (spawned.length < 2 && Date.now() < deadline2) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(spawned.length, 2);
      assert.equal(spawned[0].killedWith, "SIGTERM");

      try {
        // The stale first request closes after the replacement request has
        // registered its callback thread. Its cleanup must not delete the
        // replacement thread/token.
        spawned[0].closeNow(null, "SIGTERM");
        await Promise.race([
          firstPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("first chat did not close")), 2000)),
        ]);

        const env = spawned[1].env;
        const callbackResp = await fetch(
          `${baseUrl}/api/callbacks/thread-context?` +
            `sessionId=${encodeURIComponent(session.id)}&` +
            `invocationId=${encodeURIComponent(env.CAT_CAFE_INVOCATION_ID)}`,
          { headers: { "X-Callback-Token": env.CAT_CAFE_CALLBACK_TOKEN } }
        );
        assert.equal(callbackResp.status, 200);
      } finally {
        spawned[1].stdout.write("done");
        spawned[1].closeNow(0, null);
        await secondPromise.catch(() => {});
      }
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

  const ok = callbacks.postMessage(sessionId, invocationId, "@小谋 请继续实现", {
    appendToSession: appendFn,
  });

  assert.equal(ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].msg.role, "assistant");
  assert.equal(appended[0].msg.agent, "architect");
  assert.equal(appended[0].msg.content, "@小谋 请继续实现");
  assert.equal(worklist.includes("planner"), true);
  assert.equal(threadCtx.a2aCount, 1);

  const joined = sseEvents.join("");
  assert.match(joined, /event: message\ndata: \{"agent":"architect","role":"assistant","text":"@小谋 请继续实现"\}/);
  assert.match(joined, /event: a2a-route\ndata: \{"from":"architect","to":"planner"\}/);

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

// ── Thread Affinity + TTL tests (lesson 08) ───────────────────

test("createInvocation returns expiresAt and stamps expiresAt on the token", () => {
  const sessionId = "session-ttl-1";
  const threadCtx = {
    res: { destroyed: false, writableEnded: false, write() { return true; } },
    worklist: ["architect"],
    controller: new AbortController(),
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const before = Date.now();
  const { invocationId, callbackToken, expiresAt } = callbacks.createInvocation(sessionId, "architect");
  const after = Date.now();

  assert.ok(typeof invocationId === "string" && invocationId.length > 0);
  assert.ok(typeof callbackToken === "string" && callbackToken.length > 0);
  assert.ok(typeof expiresAt === "number");
  assert.ok(expiresAt >= before + 30 * 60 * 1000, "expiresAt should be ~30 min in the future");
  assert.ok(expiresAt <= after + 30 * 60 * 1000, "expiresAt should be ~30 min in the future");

  const stored = threadCtx.tokens.get(invocationId);
  assert.equal(stored.callbackToken, callbackToken);
  assert.equal(stored.expiresAt, expiresAt);

  callbacks.unregisterThread(sessionId);
});

test("CAT_CAFE_TOKEN_TTL_MS overrides the default TTL", () => {
  const sessionId = "session-ttl-2";
  const threadCtx = {
    res: { destroyed: false, writableEnded: false, write() { return true; } },
    worklist: ["architect"],
    controller: new AbortController(),
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const prev = process.env.CAT_CAFE_TOKEN_TTL_MS;
  process.env.CAT_CAFE_TOKEN_TTL_MS = "60000";
  try {
    const { expiresAt } = callbacks.createInvocation(sessionId, "architect");
    const expected = Date.now() + 60000;
    assert.ok(Math.abs(expiresAt - expected) < 100, `expiresAt should be ~60s in the future, got diff ${Math.abs(expiresAt - expected)}ms`);
  } finally {
    if (prev === undefined) delete process.env.CAT_CAFE_TOKEN_TTL_MS;
    else process.env.CAT_CAFE_TOKEN_TTL_MS = prev;
    callbacks.unregisterThread(sessionId);
  }
});

test("validateToken rejects expired tokens and lazily cleans them up", () => {
  const sessionId = "session-exp-1";
  const invocationId = "invocation-exp-1";
  const callbackToken = "token-exp-1";
  const threadCtx = {
    res: { destroyed: false, writableEnded: false, write() { return true; } },
    worklist: ["architect"],
    controller: new AbortController(),
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map([[invocationId, {
      agentId: "architect",
      callbackToken,
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 1000, // already expired
    }]]),
  };
  callbacks.registerThread(sessionId, threadCtx);

  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), false);
  assert.equal(threadCtx.tokens.has(invocationId), false, "expired token should be cleaned up");

  callbacks.unregisterThread(sessionId);
});

test("validateToken accepts non-expiring legacy tokens (backward compat)", () => {
  const sessionId = "session-leg-1";
  const invocationId = "invocation-leg-1";
  const callbackToken = "token-leg-1";
  const threadCtx = {
    res: { destroyed: false, writableEnded: false, write() { return true; } },
    worklist: ["architect"],
    controller: new AbortController(),
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map([[invocationId, { agentId: "architect", callbackToken }]]), // no expiresAt
  };
  callbacks.registerThread(sessionId, threadCtx);

  assert.equal(callbacks.validateToken(sessionId, invocationId, callbackToken), true);

  callbacks.unregisterThread(sessionId);
});

test("postMessage rejects cross-thread callbacks (Thread Affinity guard)", () => {
  const sseEvents = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write(chunk) { sseEvents.push(chunk); return true; },
  };
  const sessionId = "session-guard-1";
  const worklist = ["architect"];
  const controller = new AbortController();
  const threadCtx = {
    sessionId,
    res: fakeRes,
    worklist,
    controller,
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (file, sid, msg) => appended.push({ file, sid, msg });

  // Mismatched threadId must be rejected
  const ok = callbacks.postMessage("wrong-thread", "inv-1", "hello", {
    appendToSession: appendFn,
  });

  assert.equal(ok, false, "cross-thread postMessage should return false");
  assert.equal(appended.length, 0, "cross-thread message should not be persisted");
  assert.equal(sseEvents.length, 0, "cross-thread message should not be broadcast at all");

  callbacks.unregisterThread(sessionId);
});

test("postMessage allows callbacks for the bound thread (stamped by registerThread)", () => {
  const sseEvents = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write(chunk) { sseEvents.push(chunk); return true; },
  };
  const sessionId = "session-guard-2";
  const worklist = ["architect"];
  const controller = new AbortController();
  const threadCtx = {
    sessionId,
    res: fakeRes,
    worklist,
    controller,
    a2aCount: 0,
    sessionsFile: "/tmp/sessions.json",
    tokens: new Map(),
  };
  callbacks.registerThread(sessionId, threadCtx);

  const appended = [];
  const appendFn = (file, sid, msg) => appended.push({ file, sid, msg });

  const ok = callbacks.postMessage(sessionId, "inv-1", "hello", {
    appendToSession: appendFn,
  });

  assert.equal(ok, true);
  assert.equal(appended.length, 1);
  // sendSse writes two lines per event (event: + data:), so count by event name.
  const eventNames = sseEvents.filter((line) => line.startsWith("event: ")).map((line) => line.trim());
  assert.deepEqual(eventNames, ["event: message"]);

  callbacks.unregisterThread(sessionId);
});

test("prompt template injects CAT_CAFE_THREAD_ID and sessionId in the curl command", () => {
  const instructions = callbacks.buildCallbackInstructions("http://127.0.0.1:8787");
  assert.match(instructions, /\$CAT_CAFE_THREAD_ID/);
  assert.match(instructions, /\\"sessionId\\": \\"\$CAT_CAFE_THREAD_ID\\"/);
  assert.match(instructions, /TTL/);
});

// ── Transcript integration (lesson 08 Phase 1) ─────────────────

test("chat endpoint writes transcript events (invocation-start, stdout, invocation-end)", async () => {
  const transcript = require("../src/session/transcript");
  const tmpTranscriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-transcript-"));
  const prevDir = process.env.CAT_CAFE_TRANSCRIPT_DIR;
  process.env.CAT_CAFE_TRANSCRIPT_DIR = tmpTranscriptDir;
  try {
    let capturedSessionId = null;

    await withServer(
      {
        spawnRunner(command, args) {
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-transcript", text: "partial " }) + "\n");
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-transcript", text: "answer" }) + "\n");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "planner", prompt: "hello transcript" }),
        });
        const text = await response.text();
        const sessionMatch = text.match(/event: session\ndata: \{"sessionId":"([^"]+)"\}/);
        assert.ok(sessionMatch);
        capturedSessionId = sessionMatch[1];
      }
    );

    // Poll until the transcript files appear. On Windows, server.close() may
    // resolve before all fs.promises.appendFile writes finish even though the
    // handler awaits flush. Polling is more robust than a fixed sleep.
    async function waitForInvocations(sessionId, minCount, timeoutMs) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await transcript.flush();
        const invs = await transcript.listInvocations(sessionId);
        if (invs.length >= minCount) return invs;
        await new Promise((r) => setTimeout(r, 50));
      }
      return await transcript.listInvocations(sessionId);
    }

    const invocations = await waitForInvocations(capturedSessionId, 1, 3000);
    assert.ok(invocations.length >= 1, `expected at least one invocation, got: ${JSON.stringify(invocations)}`);

    // The actual agent invocation should have start, stdout (×2), and end events
    const agentInv = invocations.find((id) => id !== "_user_prompt");
    assert.ok(agentInv, "expected a non-user-prompt invocation");
    const events = await transcript.readInvocation(capturedSessionId, agentInv);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("invocation-start"), `kinds: ${kinds.join(",")}`);
    assert.ok(kinds.includes("text.delta"), `kinds: ${kinds.join(",")}`);
    assert.ok(kinds.includes("invocation-end"), `kinds: ${kinds.join(",")}`);
    const stdoutEvents = events.filter((e) => e.kind === "text.delta");
    assert.equal(stdoutEvents.length, 2, "two text.delta chunks (partial + answer)");
    assert.equal(stdoutEvents[0].payload.text, "partial ");
    assert.equal(stdoutEvents[1].payload.text, "answer");

    // The synthetic user-prompt invocation should be searchable
    const userPromptEvents = await transcript.readInvocation(capturedSessionId, "_user_prompt");
    assert.equal(userPromptEvents.length, 1);
    assert.equal(userPromptEvents[0].kind, "user-prompt");
      assert.equal(userPromptEvents[0].payload.agent, "planner");

    // Search should find the user prompt
    const hits = await transcript.searchTranscript(capturedSessionId, "transcript");
    assert.ok(hits.length >= 1, "search should find the user prompt");
  } finally {
    if (prevDir === undefined) delete process.env.CAT_CAFE_TRANSCRIPT_DIR;
    else process.env.CAT_CAFE_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpTranscriptDir, { recursive: true, force: true });
  }
});

// ── Context health + sealer integration (lesson 08 Phase 2) ─────

test("chat endpoint emits context-warning when fillRatio crosses warn threshold", async () => {
  // Tiny capacity so even a small chunk triggers the warn threshold.
  const prevCapacity = process.env.CAT_CAFE_TEST_CAPACITY;
  process.env.CAT_CAFE_TEST_CAPACITY = "20";

  try {
    await withServer(
      {
        spawnRunner(command, args) {
          const child = createMockChild();
          process.nextTick(() => {
            // capacity 20 tokens × 4 chars/token = 80 char capacity
            // 25 chars output → ratio 25/80 = 0.31 (under warn)
            // 60 chars output → ratio 60/80 = 0.75 (under warn, since warn is 0.85)
            // 80 chars output → ratio 80/80 = 1.0 (above action 0.90, triggers seal)
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "inv-warn", text: "x".repeat(80) }) + "\n");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "planner", prompt: "hi" }),
        });
        const text = await response.text();
        // We expect context-warning (or sealed, depending on ratio) because
        // the small test capacity forces the ratio above 0.85.
        const hasContextEvent = /event: (context-warning|sealed)/.test(text);
        assert.ok(hasContextEvent, `expected context-warning or sealed event in stream, got: ${text.slice(-500)}`);
      }
    );
  } finally {
    if (prevCapacity === undefined) delete process.env.CAT_CAFE_TEST_CAPACITY;
    else process.env.CAT_CAFE_TEST_CAPACITY = prevCapacity;
  }
});

test("chat endpoint terminates the chain with sealed event when action threshold crossed", async () => {
  // Very tiny capacity so the very first stdout chunk pushes ratio past 0.90.
  const prevCapacity = process.env.CAT_CAFE_TEST_CAPACITY;
  process.env.CAT_CAFE_TEST_CAPACITY = "20";

  try {
    await withServer(
      {
        spawnRunner(command, args) {
          const child = createMockChild();
          process.nextTick(() => {
            // 80 chars × 4 chars/token / 20 tokens capacity = ratio 4.0, well past 0.90
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "architect", invocationId: "inv-seal", text: "x".repeat(80) }) + "\n");
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "architect", invocationId: "inv-seal", text: "\n@sage please continue" }) + "\n");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "architect", prompt: "start" }),
        });
        const text = await response.text();
        // The sealed event must fire for the first agent (architect), not after
        // A2A routing to sage.
        assert.match(text, /event: sealed\ndata: \{"agent":"architect".*"reason":"context overflow"\}/);
      }
    );
  } finally {
    if (prevCapacity === undefined) delete process.env.CAT_CAFE_TEST_CAPACITY;
    else process.env.CAT_CAFE_TEST_CAPACITY = prevCapacity;
  }
});

// ── Phase 3: transcript callback endpoints ─────────────────────

/**
 * Helper: run a chat with a long-running mock so callback requests can fire
 * while the agent is still active. Returns { baseUrl, captured, close } where
 * captured.invocationId and captured.callbackToken are set once spawnRunner is
 * called.
 */
async function withActiveChat(fn) {
  const transcript = require("../src/session/transcript");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-"));
  const prevDir = process.env.CAT_CAFE_TRANSCRIPT_DIR;
  process.env.CAT_CAFE_TRANSCRIPT_DIR = tmpDir;

  const captured = { env: null, kill: null };

  try {
    await withServer(
      {
        spawnRunner(command, args, options = {}) {
          captured.env = options.env;
          const child = createMockChild();
          let killed = false;
          child.kill = (sig) => {
            if (killed) return true;
            killed = true;
            setImmediate(() => child.emit("close", null, sig || "SIGTERM"));
            return true;
          };
          captured.kill = () => child.kill("SIGTERM");
          return child;
        },
      },
      async (baseUrl) => {
        const knownSessionId = "phase3-active-session";

        // Fire the chat in background; the mock holds the child open so we can
        // poke the callback endpoints while it's "running".
        const chatPromise = fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "planner",
            prompt: "long running task about redis clustering",
            sessionId: knownSessionId,
          }),
        });

        // Wait for spawnRunner to be called (env captured)
        const deadline = Date.now() + 2000;
        while (!captured.env && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(captured.env, "spawnRunner should have been called within 2s");

        // Give the chat handler a moment to finish registerThread/createInvocation
        await new Promise((r) => setTimeout(r, 50));

        try {
          await fn(baseUrl, knownSessionId, captured);
        } finally {
          if (captured.kill) captured.kill();
          await chatPromise.catch(() => {});
        }
      }
    );
  } finally {
    if (prevDir === undefined) delete process.env.CAT_CAFE_TRANSCRIPT_DIR;
    else process.env.CAT_CAFE_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("/api/callbacks/session-search rejects without X-Callback-Token", async () => {
  await withServer({}, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/api/callbacks/session-search?sessionId=x&invocationId=y&query=z`);
    assert.equal(resp.status, 400);
  });
});

test("/api/callbacks/session-search rejects invalid token with 401", async () => {
  await withServer({}, async (baseUrl) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=x&invocationId=y&query=z`,
      { headers: { "X-Callback-Token": "wrong" } }
    );
    assert.equal(resp.status, 401);
  });
});

test("/api/callbacks/session-search rejects missing query with 400", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${sid}&invocationId=${captured.env.CAT_CAFE_INVOCATION_ID}`,
      { headers: { "X-Callback-Token": captured.env.CAT_CAFE_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 400);
  });
});

test("/api/callbacks/session-search returns hits during active chat", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const invId = captured.env.CAT_CAFE_INVOCATION_ID;
    const token = captured.env.CAT_CAFE_CALLBACK_TOKEN;

    // Give the user-prompt transcript event time to flush
    await new Promise((r) => setTimeout(r, 200));

    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(invId)}&` +
        `query=${encodeURIComponent("redis clustering")}&` +
        `limit=10`,
      { headers: { "X-Callback-Token": token } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.query, "redis clustering");
    assert.equal(body.limit, 10);
    assert.ok(body.hits.length >= 1, `expected at least one hit, got ${JSON.stringify(body.hits)}`);
    assert.match(body.hits[0].snippet, /redis clustering/);
  });
});

test("/api/callbacks/session-search caps limit at 200", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/session-search?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(captured.env.CAT_CAFE_INVOCATION_ID)}&` +
        `query=redis&limit=99999`,
      { headers: { "X-Callback-Token": captured.env.CAT_CAFE_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body.limit <= 200, `limit should be capped at 200, got ${body.limit}`);
  });
});

test("/api/callbacks/list-invocations returns agent + state metadata", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    // Give invocation-start time to flush
    await new Promise((r) => setTimeout(r, 200));

    const resp = await fetch(
      `${baseUrl}/api/callbacks/list-invocations?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(captured.env.CAT_CAFE_INVOCATION_ID)}`,
      { headers: { "X-Callback-Token": captured.env.CAT_CAFE_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(Array.isArray(body.invocations));
    // The active invocation should appear (in-flight, no end event yet)
    const active = body.invocations.find((i) => i.invocationId === captured.env.CAT_CAFE_INVOCATION_ID);
    assert.ok(active, `active invocation should be listed, got: ${JSON.stringify(body.invocations)}`);
    assert.equal(active.agent, "planner");
    assert.ok(active.startedAt);
    assert.equal(active.endedAt, null);
    assert.equal(active.state, null);
    assert.ok(active.eventCount >= 1);
  });
});

test("/api/callbacks/read-invocation returns paginated events", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    // Give invocation-start time to flush
    await new Promise((r) => setTimeout(r, 200));

    const invId = captured.env.CAT_CAFE_INVOCATION_ID;
    const resp = await fetch(
      `${baseUrl}/api/callbacks/read-invocation?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(invId)}&` +
        `targetInvocationId=${encodeURIComponent(invId)}&` +
        `from=0&limit=10`,
      { headers: { "X-Callback-Token": captured.env.CAT_CAFE_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.invocationId, invId);
    assert.equal(body.from, 0);
    assert.equal(body.limit, 10);
    assert.ok(body.total >= 1);
    assert.ok(body.events.length >= 1);
    // The first event should be invocation-start
    assert.equal(body.events[0].kind, "invocation-start");
  });
});

test("/api/callbacks/read-invocation requires targetInvocationId", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    const resp = await fetch(
      `${baseUrl}/api/callbacks/read-invocation?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(captured.env.CAT_CAFE_INVOCATION_ID)}`,
      { headers: { "X-Callback-Token": captured.env.CAT_CAFE_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 400);
  });
});

test("/api/callbacks/read-invocation pagination slices correctly", async () => {
  await withActiveChat(async (baseUrl, sid, captured) => {
    // Inject a bunch of stdout events so pagination has something to slice
    const transcript = require("../src/session/transcript");
    const invId = captured.env.CAT_CAFE_INVOCATION_ID;
    for (let i = 0; i < 10; i++) {
      transcript.appendEvent(sid, invId, "stdout", { text: `chunk-${i}` });
    }
    await transcript.flush();

    const resp = await fetch(
      `${baseUrl}/api/callbacks/read-invocation?` +
        `sessionId=${encodeURIComponent(sid)}&` +
        `invocationId=${encodeURIComponent(invId)}&` +
        `targetInvocationId=${encodeURIComponent(invId)}&` +
        `from=2&limit=3`,
      { headers: { "X-Callback-Token": captured.env.CAT_CAFE_CALLBACK_TOKEN } }
    );
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.from, 2);
    assert.equal(body.limit, 3);
    assert.ok(body.events.length === 3, `expected 3 events, got ${body.events.length}`);
  });
});

test("buildCallbackInstructions mentions all 3 new endpoints", () => {
  const tpl = callbacks.buildCallbackInstructions("http://127.0.0.1:8787");
  assert.match(tpl, /\/api\/callbacks\/list-invocations/);
  assert.match(tpl, /\/api\/callbacks\/session-search/);
  assert.match(tpl, /\/api\/callbacks\/read-invocation/);
  assert.match(tpl, /不要凭印象猜/);
});

test("parseUnifiedDiff splits multi-file patches into file entries", () => {
  const { parseUnifiedDiff } = require("../public/workspace-diff.js");
  const diff = [
    "diff --git a/public/app.js b/public/app.js",
    "--- a/public/app.js",
    "+++ b/public/app.js",
    "@@ -1,2 +1,3 @@",
    " line 1",
    "+line 2",
    "diff --git a/public/new-file.js b/public/new-file.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/public/new-file.js",
    "@@ -0,0 +1,2 @@",
    "+export const ok = true;",
    "+console.log(ok);",
  ].join("\n");

  const files = parseUnifiedDiff(diff);
  assert.deepEqual(
    files.map((file) => ({ path: file.path, status: file.status })),
    [
      { path: "public/app.js", status: "modified" },
      { path: "public/new-file.js", status: "untracked" },
    ]
  );
  assert.match(files[1].patch, /new file mode 100644/);
});

test("summarizeUnifiedDiff counts total and untracked files", () => {
  const { summarizeUnifiedDiff } = require("../public/workspace-diff.js");
  const files = [
    { path: "public/app.js", status: "modified", patch: "@@ -1 +1,2 @@\n line 1\n+line 2" },
    { path: "public/new-file.js", status: "untracked", patch: "new file mode 100644\n+console.log('ok');" },
  ];

  assert.deepEqual(summarizeUnifiedDiff(files), {
    totalFiles: 2,
    untrackedFiles: 1,
    hasDiff: true,
  });
});

test("frontend index.html exposes explicit worktree mode toggle", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /id="use-worktree"/);
  assert.match(html, /title="为本次对话创建或复用隔离 worktree"/);
});

test("frontend exposes agent and workspace panel tabs", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /id="panel-tab-agents"/);
  assert.match(html, /id="panel-tab-workspace"/);
  assert.match(html, /id="workspace-panel"/);
  assert.match(html, /src="\/public\/session-api\.js"/);
  assert.match(html, /src="\/public\/session-controller\.js"/);
  assert.match(html, /src="\/public\/worktree-api\.js"/);
  assert.match(html, /src="\/public\/recall-api\.js"/);
  assert.match(html, /src="\/public\/chat-client\.js"/);
  assert.match(html, /src="\/public\/workspace-diff\.js"/);
});

test("frontend uses unified Chinese console copy in the main shell", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /多 Agent 协作台/);
  assert.match(html, /已激活能力/);
  assert.match(html, /参与 Agent/);
  assert.match(html, />清空</);
  assert.match(html, />发送</);
  assert.doesNotMatch(html, />Agent Chat</);
  assert.doesNotMatch(html, />Rules</);
  assert.doesNotMatch(html, />Models</);
});

test("frontend app.js sends useWorktree from the explicit toggle", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const chatJs = fs.readFileSync(path.join(__dirname, "../public", "chat-client.js"), "utf8");
  assert.match(appJs, /const useWorktreeInput\s*=\s*\$\("#use-worktree"\)/);
  assert.match(appJs, /window\.ChatClient\.createChatClient/);
  assert.match(chatJs, /useWorktree:\s*useWorktreeInput\.checked/);
});

test("frontend app.js defines unified display helpers for user and agent identities", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /function roleDisplayName\(role, agentId\)/);
  assert.match(js, /return role === "user" \? "用户" : agentLabel\(agentId\);/);
  assert.match(js, /function roleBadgeLabel\(role\)/);
  assert.match(js, /metaLabel\.textContent = roleDisplayName\(role, agent\)/);
  assert.match(js, /metaRole\.textContent = roleBadgeLabel\(role\)/);
});

test("frontend app.js loads workspace status and diff for the workspace tab", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /rightPanelTab:\s*"agents"/);
  assert.match(js, /async function loadWorkspaceState\(\)/);
  assert.match(js, /window\.WorktreeApi\.createWorktreeApi/);
  assert.match(js, /worktreeApi\.readStatus\(state\.currentSessionId,\s*\{\s*allowMissing:\s*true\s*\}\)/);
  assert.match(js, /worktreeApi\.readDiff\(state\.currentSessionId,\s*\{\s*allowMissing:\s*true\s*\}\)/);
  assert.match(js, /function renderWorkspacePanel\(\)/);
});

test("frontend app.js handles missing worktree and discard actions", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /当前会话尚未创建 worktree/);
  assert.match(js, /当前无改动/);
  assert.match(js, /async function discardWorkspace\(\)/);
  assert.match(js, /worktreeApi\.discard\(state\.currentSessionId\)/);
});

test("frontend app.js renders workspace file selection and diff output", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /function renderWorkspaceFileList\(\)/);
  assert.match(js, /function renderWorkspaceDiff\(\)/);
  assert.match(js, /workspace\.selectedPath = path/);
  assert.match(js, /打开预览/);
  assert.match(js, /刷新改动/);
});

test("frontend treats sealed SSE event as an expected terminal state", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const chatJs = fs.readFileSync(path.join(__dirname, "../public", "chat-client.js"), "utf8");
  assert.match(chatJs, /case "sealed":/);
  assert.match(chatJs, /context overflow/);
  assert.match(appJs, /state\.doneReceived = true/);
});

test("frontend lets model cards insert an agent mention", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /item\.addEventListener\("click"[\s\S]*insertAgentMention/);
  assert.match(js, /function insertAgentMention/);
});

test("frontend keeps right-side agent and workspace surfaces in a shared tab system", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /panelTabAgentsEl\.addEventListener\("click"/);
  assert.match(js, /panelTabWorkspaceEl\.addEventListener\("click"/);
  assert.match(js, /state\.rightPanelTab = "workspace"/);
  assert.match(js, /loadWorkspaceState\(\)/);
});

test("frontend exposes delete session button on keyboard focus", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.btn-delete-session:focus-visible/);
});

test("frontend app.js uses plain-text live streaming instead of segmented markdown streaming", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /liveText\.className = "stream-live-text"/);
  assert.match(js, /item\._liveTextEl\.textContent = raw/);
  assert.doesNotMatch(js, /function splitIntoSegments/);
  assert.doesNotMatch(js, /stream-suffix/);
});

test("frontend styles.css defines plain-text live streaming style", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.stream-live-text\s*\{/);
  assert.doesNotMatch(css, /\.stream-suffix\s*\{/);
});

test("frontend keeps thinking and writing as badge-only live states", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  assert.match(js, /function showThinking\(agent\)/);
  assert.match(js, /item\.setBadge\("thinking"\)/);
  assert.match(js, /bubble\.classList\.add\("msg-bubble-live-pending"\)/);
  assert.match(js, /function appendLive\(agent, text\)/);
  assert.match(js, /item\.bubble\.classList\.remove\("msg-bubble-live-pending"\)/);
  assert.match(js, /item\.setBadge\("writing"\)/);
  assert.doesNotMatch(js, /thinking-text/);
});

test("frontend routes stderr SSE into a separate system stderr message", () => {
  const appJs = fs.readFileSync(path.join(__dirname, "../public", "app.js"), "utf8");
  const chatJs = fs.readFileSync(path.join(__dirname, "../public", "chat-client.js"), "utf8");
  assert.match(chatJs, /case "stderr":/);
  assert.match(appJs, /function addDebug\(agent, text\)/);
  assert.match(appJs, /createMessage\(\{ role: "system", agent, content: text, variant: "stderr" \}\)/);
  assert.match(chatJs, /addDebug\(data\.agent, data\.text\)/);
  assert.doesNotMatch(appJs, /createMessage\(\{ role: "assistant", agent: data\.agent, content: data\.text, variant: "stderr" \}\)/);
});

test("frontend styles.css gives stderr messages a separate debug appearance", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.system\.stderr \.msg-bubble/);
  assert.match(css, /\.system\.stderr \.msg-meta/);
});

test("frontend styles define a shared card system for messages and agent roles", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.msg-card/);
  assert.match(css, /\.message\.user \.msg-card/);
  assert.match(css, /\.message\.assistant \.msg-card/);
  assert.match(css, /\.agent-tab-role/);
});

test("frontend styles.css defines workspace panel layout and diff colors", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public", "styles.css"), "utf8");
  assert.match(css, /\.panel-tabs/);
  assert.match(css, /\.workspace-panel/);
  assert.match(css, /\.workspace-file-list/);
  assert.match(css, /\.workspace-diff/);
  assert.match(css, /\.workspace-diff-line-added/);
  assert.match(css, /\.workspace-diff-line-removed/);
});

// ── Phase 4: Session Bootstrap ──────────────────────────────────

test("chat endpoint injects bootstrap packet (identity + recall rule) into first agent's prompt", async () => {
  const transcript = require("../src/session/transcript");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-inject-"));
  const prevDir = process.env.CAT_CAFE_TRANSCRIPT_DIR;
  process.env.CAT_CAFE_TRANSCRIPT_DIR = tmpDir;

  let capturedPrompt = null;

  try {
    await withServer(
      {
        spawnRunner(command, args) {
          // Last positional arg is the prompt
          capturedPrompt = args[args.length - 1];
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write("ok");
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
            agent: "planner",
            prompt: "hello world",
            sessionId: "bootstrap-test-session",
          }),
        });
        await response.text();
      }
    );

    assert.ok(capturedPrompt, "spawnRunner should have been called");
    // Identity section
    assert.match(capturedPrompt, /<!-- Session Identity -->/);
    assert.match(capturedPrompt, /Thread: bootstrap-test-session/);
    assert.match(capturedPrompt, /Session: bootstrap-test-session/);
    assert.match(capturedPrompt, /Agent: 小谋/);
    // Digest section (empty for new session with fresh dir)
    assert.match(capturedPrompt, /<!-- Digest -->/);
    assert.match(capturedPrompt, /第一个 invocation/);
    // Recall rule
    assert.match(capturedPrompt, /<!-- 回忆铁律/);
    assert.match(capturedPrompt, /不要凭印象猜/);
    // User prompt still in there
    assert.match(capturedPrompt, /hello world/);
  } finally {
    if (prevDir === undefined) delete process.env.CAT_CAFE_TRANSCRIPT_DIR;
    else process.env.CAT_CAFE_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("A2A-routed agents do NOT get bootstrap packet (handoff block instead)", async () => {
  const prompts = [];

  await withServer(
    {
      spawnRunner(command, args) {
        prompts.push(args[args.length - 1]);
        const child = createMockChild();
        process.nextTick(() => {
          if (args[2] === "architect") {
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "architect", invocationId: "bootstrap-a2a-1", text: "@小谋\nhandoff please\narchitect result" }) + "\n");
          } else {
            child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "bootstrap-a2a-2", text: "planner received" }) + "\n");
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
        body: JSON.stringify({
          agent: "architect",
          prompt: "start",
          sessionId: "bootstrap-a2a-test",
        }),
      });
      await response.text();
    }
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /<!-- Session Identity -->/);
  assert.match(prompts[0], /<!-- 回忆铁律/);
  assert.doesNotMatch(prompts[1], /<!-- Session Identity -->/);
  assert.doesNotMatch(prompts[1], /<!-- 回忆铁律/);
  assert.match(prompts[1], /任务交接/);
  assert.match(prompts[1], /architect result/);
});

test("bootstrap digest lists prior invocations when chat is re-entered with same sessionId", async () => {
  const transcript = require("../src/session/transcript");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-resume-"));
  const prevDir = process.env.CAT_CAFE_TRANSCRIPT_DIR;
  process.env.CAT_CAFE_TRANSCRIPT_DIR = tmpDir;

  const sessionId = "bootstrap-resume-test";
  let firstPrompts = null;
  let secondPrompt = null;

  try {
    await withServer(
      {
        spawnRunner(command, args) {
          if (!firstPrompts) firstPrompts = [args[args.length - 1]];
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write("first done");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        await (await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "planner", prompt: "first", sessionId }),
        })).text();
      }
    );

    await transcript.flush();
    await new Promise((r) => setTimeout(r, 200));

    await withServer(
      {
        spawnRunner(command, args) {
          secondPrompt = args[args.length - 1];
          const child = createMockChild();
          process.nextTick(() => {
            child.stdout.write("second done");
            child.emit("close", 0, null);
          });
          return child;
        },
      },
      async (baseUrl) => {
        await (await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent: "orchestrator", prompt: "second", sessionId }),
        })).text();
      }
    );

    assert.ok(firstPrompts && firstPrompts.length >= 1, "first chat should have run");
    assert.ok(secondPrompt, "second chat should have run");
    assert.match(firstPrompts[0], /第一个 invocation/);
    assert.match(secondPrompt, /<!-- Digest/);
    assert.doesNotMatch(secondPrompt, /第一个 invocation/);
  } finally {
    if (prevDir === undefined) delete process.env.CAT_CAFE_TRANSCRIPT_DIR;
    else process.env.CAT_CAFE_TRANSCRIPT_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Recall (memory/回忆) tests ────────────────────────────────

test("buildCallbackInstructions includes sessionId, CAT_CAFE_THREAD_ID and recall routes", () => {
  const instructions = callbacks.buildCallbackInstructions("http://example.test", "session-xyz");
  assert.match(instructions, /\$CAT_CAFE_THREAD_ID/);
  assert.ok(instructions.includes("sessionId=$CAT_CAFE_THREAD_ID"), "should reference sessionId=$CAT_CAFE_THREAD_ID");
  assert.ok(instructions.includes('\\"sessionId\\": \\"$CAT_CAFE_THREAD_ID\\"'), "post-message body should include sessionId");
  assert.match(instructions, /\/api\/callbacks\/list-invocations/);
  assert.match(instructions, /\/api\/callbacks\/session-search/);
  assert.match(instructions, /\/api\/callbacks\/read-invocation/);
});

test("chat records invocation events and recall routes expose them (no token = frontend path)", async () => {
  await withServer(
    {
      spawnRunner() {
        const child = createMockChild();
        process.nextTick(() => {
          child.stdout.write(JSON.stringify({ type: "text.delta", agent: "planner", invocationId: "recall-1", text: "hello recall" }) + "\n");
          child.stderr.write("a stderr line\n");
          child.emit("close", 0, null);
        });
        return child;
      },
    },
    async (baseUrl) => {
      const chat = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "planner", prompt: "remember this" }),
      });
      const chatText = await chat.text();
      const sidMatch = chatText.match(/event: session\ndata: \{"sessionId":"([^"]+)"\}/);
      assert.ok(sidMatch, "expected session event");
      const sid = sidMatch[1];
      const invMatch = chatText.match(/event: agent-start\ndata: \{"agent":"planner","invocationId":"([^"]+)"\}/);
      assert.ok(invMatch, "expected agent-start with invocationId");
      const invId = invMatch[1];

      const listRes = await fetch(`${baseUrl}/api/callbacks/list-invocations?sessionId=${sid}`);
      const list = await listRes.json();
      assert.equal(listRes.status, 200);
      assert.equal(list.invocations.length, 1);
      assert.equal(list.invocations[0].invocationId, invId);
      assert.equal(list.invocations[0].agent, "planner");
      assert.equal(list.invocations[0].state, "completed");
      assert.ok(list.invocations[0].eventCount >= 3, "should have start + text.delta + stderr + end events");

      const readRes = await fetch(`${baseUrl}/api/callbacks/read-invocation?sessionId=${sid}&targetInvocationId=${invId}`);
      const read = await readRes.json();
      assert.equal(readRes.status, 200);
      assert.equal(read.invocationId, invId);
      assert.equal(read.total, read.events.length);
      const kinds = read.events.map((e) => e.kind);
      assert.ok(kinds.includes("invocation-start"));
      assert.ok(kinds.includes("text.delta"));
      assert.ok(kinds.includes("stderr"));
      assert.ok(kinds.includes("invocation-end"));

      const searchRes = await fetch(`${baseUrl}/api/callbacks/session-search?sessionId=${sid}&query=hello%20recall`);
      const search = await searchRes.json();
      assert.equal(searchRes.status, 200);
      assert.ok(search.hits.length >= 1);
      assert.equal(search.hits[0].invocationId, invId);

      const histRes = await fetch(`${baseUrl}/api/messages?sessionId=${sid}`);
      const hist = await histRes.json();
      const assistant = hist.messages.find((m) => m.role === "assistant");
      assert.ok(assistant, "should have an assistant message");
      assert.equal(assistant.invocationId, invId);
    }
  );
});

test("read-invocation returns 404 for unknown invocation", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/callbacks/read-invocation?sessionId=any&targetInvocationId=missing`);
    assert.equal(res.status, 404);
  });
});

test("list-invocations requires sessionId", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/callbacks/list-invocations`);
    assert.equal(res.status, 400);
  });
});

test("read-invocation requires targetInvocationId", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/callbacks/read-invocation?sessionId=any`);
    assert.equal(res.status, 400);
  });
});

test("recall routes reject invalid agent token when one is provided", async () => {
  await withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/callbacks/list-invocations?sessionId=s&invocationId=i`, {
      headers: { "x-callback-token": "bad" },
    });
    assert.equal(res.status, 401);
  });
});

test("invocation event helpers are pure and session-scoped", () => {
  const {
    recordInvocationEvent,
    finalizeInvocationEvent,
    listInvocationsFromMap,
    searchInvocationsInMap,
    readInvocationFromMap,
  } = require("../src/server/index");
  const map = new Map();
  map.set("inv-1", {
    invocationId: "inv-1",
    sessionId: "s-1",
    agent: "planner",
    startedAt: "2026-06-30T10:00:00Z",
    endedAt: null,
    state: "active",
    events: [],
  });
  recordInvocationEvent(map, "inv-1", "stdout", { text: "redis port 6379" });
  recordInvocationEvent(map, "inv-1", "stdout", { text: "done" });
  finalizeInvocationEvent(map, "inv-1", 0, null);

  const list = listInvocationsFromMap(map, "s-1");
  assert.equal(list.length, 1);
  assert.equal(list[0].state, "completed");
  assert.equal(list[0].eventCount, 3);

  const hits = searchInvocationsInMap(map, "s-1", "redis", 10);
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /redis/);

  const read = readInvocationFromMap(map, "s-1", "inv-1", 0, 10);
  assert.equal(read.total, 3);
  assert.equal(read.events.length, 3);
  assert.equal(read.from, 0);
  assert.equal(read.limit, 10);

  assert.equal(listInvocationsFromMap(map, "other").length, 0);
  assert.equal(readInvocationFromMap(map, "other", "inv-1", 0, 10), null);
});
