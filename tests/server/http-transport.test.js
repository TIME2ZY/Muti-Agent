const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { sendJson, sendSse, readJsonBody } = require("../../src/server/http-transport");

test("HTTP transport serializes JSON and SSE consistently", () => {
  const writes = [];
  const res = {
    writeHead(status, headers) {
      writes.push({ status, headers });
    },
    write(value) {
      writes.push(value);
    },
    end(value) {
      writes.push(value);
    },
  };

  sendJson(res, 201, { ok: true });
  sendSse(res, "done", { id: 1 });

  assert.equal(writes[0].status, 201);
  assert.equal(writes[1], '{"ok":true}');
  assert.deepEqual(writes.slice(2), ["event: done\n", 'data: {"id":1}\n\n']);
});

test("readJsonBody parses input and enforces its size boundary", async () => {
  const valid = new EventEmitter();
  valid.setEncoding = () => {};
  valid.destroy = () => {};
  const parsed = readJsonBody(valid);
  valid.emit("data", '{"prompt":"hi"}');
  valid.emit("end");
  assert.deepEqual(await parsed, { prompt: "hi" });

  const oversized = new EventEmitter();
  oversized.setEncoding = () => {};
  oversized.destroy = () => {};
  const rejected = readJsonBody(oversized, 3);
  oversized.emit("data", "1234");
  await assert.rejects(rejected, /too large/i);
});
