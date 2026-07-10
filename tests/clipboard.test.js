const assert = require("node:assert/strict");
const test = require("node:test");

const clipboardModule = require("../public/clipboard.js");

test("writeClipboard uses ClipboardItem array when html markup is provided", async () => {
  const writes = [];
  function FakeClipboardItem(data) {
    this.data = data;
  }

  await clipboardModule.writeClipboard({
    clipboard: {
      async write(items) {
        writes.push(items);
      },
      async writeText() {
        throw new Error("writeText should not be used for rich payloads");
      },
    },
    ClipboardItem: FakeClipboardItem,
  }, {
    text: "plain",
    html: "<strong>plain</strong>",
  });

  assert.equal(writes.length, 1);
  assert.equal(Array.isArray(writes[0]), true);
  assert.equal(writes[0].length, 1);
  assert.ok(writes[0][0] instanceof FakeClipboardItem);
  assert.deepEqual(writes[0][0].data, {
    "text/plain": "plain",
    "text/html": "<strong>plain</strong>",
  });
});

test("writeClipboard falls back to writeText for plain text", async () => {
  const writes = [];

  await clipboardModule.writeClipboard({
    clipboard: {
      async write() {
        throw new Error("write should not be used for plain text");
      },
      async writeText(text) {
        writes.push(text);
      },
    },
    ClipboardItem: function ClipboardItem() {},
  }, {
    text: "plain only",
  });

  assert.deepEqual(writes, ["plain only"]);
});
