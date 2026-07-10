const assert = require("node:assert/strict");
const test = require("node:test");

const latestRequestModule = require("../public/latest-request.js");

test("createLatestRequestRunner applies only the latest resolved result", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const applied = [];
  const runner = latestRequestModule.createLatestRequestRunner();

  const firstRun = runner.run(() => first, {
    onResolve(value) {
      applied.push(["first", value]);
    },
  });

  const secondRun = runner.run(async () => "second", {
    onResolve(value) {
      applied.push(["second", value]);
    },
  });

  resolveFirst("first");

  const secondResult = await secondRun;
  const firstResult = await firstRun;

  assert.deepEqual(applied, [["second", "second"]]);
  assert.equal(secondResult.applied, true);
  assert.equal(secondResult.value, "second");
  assert.equal(firstResult.applied, false);
  assert.equal(firstResult.value, "first");
});

test("createLatestRequestRunner rejects the latest failure for explicit handling", async () => {
  const runner = latestRequestModule.createLatestRequestRunner();
  await assert.rejects(
    runner.run(async () => { throw new Error("network down"); }),
    /network down/
  );
});

test("createLatestRequestRunner suppresses a stale failure", async () => {
  let rejectFirst;
  const first = new Promise((resolve, reject) => {
    rejectFirst = reject;
  });
  const runner = latestRequestModule.createLatestRequestRunner();
  const firstRun = runner.run(() => first);
  const secondRun = runner.run(async () => "latest");
  rejectFirst(new Error("stale failure"));

  assert.equal((await secondRun).applied, true);
  const stale = await firstRun;
  assert.equal(stale.applied, false);
  assert.match(stale.error.message, /stale failure/);
});
