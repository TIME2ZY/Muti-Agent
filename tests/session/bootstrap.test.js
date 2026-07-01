const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sessionBootstrap = require("../../src/session/bootstrap");
const transcript = require("../../src/session/transcript");

const { buildIdentity, buildDigest, buildBootstrapPacket, RECALL_RULE } = sessionBootstrap;

function withTempDir(fn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
    transcript.setTranscriptDir(tmpDir);
    try {
      await fn(tmpDir);
    } finally {
      transcript.setTranscriptDir("");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

// ── buildIdentity ──────────────────────────────────────────────

test("buildIdentity includes thread, session, generation, agent label", () => {
  const id = buildIdentity({
    threadId: "thread-1",
    sessionId: "session-1",
    agent: { id: "sage", label: "小智" },
    generation: 1,
  });
  assert.match(id, /Thread: thread-1/);
  assert.match(id, /Session: session-1/);
  assert.match(id, /Agent: 小智/);
  assert.match(id, /Generation: 1/);
});

test("buildIdentity falls back to agent.id when label missing", () => {
  const id = buildIdentity({ threadId: "t", sessionId: "s", agent: { id: "sage" } });
  assert.match(id, /Agent: sage/);
});

test("buildIdentity handles plain string agent", () => {
  const id = buildIdentity({ threadId: "t", sessionId: "s", agent: "forge" });
  assert.match(id, /Agent: forge/);
});

test("buildIdentity default generation is 1", () => {
  const id = buildIdentity({ threadId: "t", sessionId: "s", agent: "sage" });
  assert.match(id, /Generation: 1/);
});

// ── buildDigest ────────────────────────────────────────────────

test("buildDigest says 'first invocation' for empty session", withTempDir(async () => {
  const digest = await buildDigest({ threadId: "t", sessionId: "empty-session" });
  assert.match(digest, /<!-- Digest -->/);
  assert.match(digest, /第一个 invocation/);
  assert.match(digest, /尚无历史/);
}));

test("buildDigest lists existing invocations with metadata", withTempDir(async () => {
  transcript.appendEvent("s1", "i1", "invocation-start", { agent: "architect" });
  await new Promise((r) => setTimeout(r, 5));
  transcript.appendEvent("s1", "i1", "stdout", { text: "thinking" });
  await new Promise((r) => setTimeout(r, 5));
  transcript.appendEvent("s1", "i1", "invocation-end", { code: 0, sealerState: "active" });
  await transcript.flush();

  const digest = await buildDigest({ threadId: "s1", sessionId: "s1" });
  assert.match(digest, /1 invocations in this session/);
  assert.match(digest, /i1/);
  assert.match(digest, /architect/);
  assert.match(digest, /state=completed/);
  assert.match(digest, /events=3/);
  assert.match(digest, /duration=\d+ms/);
}));

test("buildDigest handles in-flight invocation (no end event)", withTempDir(async () => {
  transcript.appendEvent("s1", "i1", "invocation-start", { agent: "sage" });
  await transcript.flush();

  const digest = await buildDigest({ threadId: "s1", sessionId: "s1" });
  assert.match(digest, /i1/);
  assert.match(digest, /in-flight/);
}));

// ── RECALL_RULE ────────────────────────────────────────────────

test("RECALL_RULE contains the three recall steps + key phrases", () => {
  assert.match(RECALL_RULE, /回忆铁律/);
  assert.match(RECALL_RULE, /session-search/);
  assert.match(RECALL_RULE, /read-invocation/);
  assert.match(RECALL_RULE, /不要凭印象猜/);
  assert.match(RECALL_RULE, /不要凭印象猜/);
});

// ── buildBootstrapPacket ───────────────────────────────────────

test("buildBootstrapPacket composes identity + digest + recall rule", withTempDir(async () => {
  const packet = await buildBootstrapPacket({
    threadId: "t1",
    sessionId: "s1",
    agent: { id: "sage", label: "小智" },
  });

  // Identity
  assert.match(packet, /<!-- Session Identity -->/);
  assert.match(packet, /Thread: t1/);
  assert.match(packet, /Agent: 小智/);

  // Digest
  assert.match(packet, /<!-- Digest -->/);
  assert.match(packet, /第一个 invocation/);

  // Recall rule
  assert.match(packet, /<!-- 回忆铁律/);
  assert.match(packet, /不要凭印象猜/);

  // Order matters: identity should come before digest, digest before recall rule
  const identityIdx = packet.indexOf("<!-- Session Identity -->");
  const digestIdx = packet.indexOf("<!-- Digest -->");
  const recallIdx = packet.indexOf("<!-- 回忆铁律");
  assert.ok(identityIdx < digestIdx, "identity should come before digest");
  assert.ok(digestIdx < recallIdx, "digest should come before recall rule");
}));

test("buildBootstrapPacket rejects missing threadId", async () => {
  await assert.rejects(
    () => buildBootstrapPacket({ sessionId: "s", agent: "sage" }),
    /threadId is required/
  );
});

test("buildBootstrapPacket rejects missing sessionId", async () => {
  await assert.rejects(
    () => buildBootstrapPacket({ threadId: "t", agent: "sage" }),
    /sessionId is required/
  );
});

test("buildBootstrapPacket rejects missing agent", async () => {
  await assert.rejects(
    () => buildBootstrapPacket({ threadId: "t", sessionId: "s" }),
    /agent is required/
  );
});

test("buildBootstrapPacket supports custom generation", withTempDir(async () => {
  const packet = await buildBootstrapPacket({
    threadId: "t1",
    sessionId: "s1",
    agent: "sage",
    generation: 5,
  });
  assert.match(packet, /Generation: 5/);
}));
