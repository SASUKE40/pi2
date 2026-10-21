import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CLI help works without SDK credentials", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pi2/);
  assert.equal(result.stderr, "");
});

for (const args of [[], [""], ["one", "two"], ["task", "--timeout", "NaN"], ["task", "--timeout", "0"], ["task", "--unknown"]]) {
  test(`CLI rejects invalid arguments: ${JSON.stringify(args)}`, () => {
    const result = spawnSync(process.execPath, ["dist/cli.js", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pi2:/);
    assert.equal(result.stdout, "");
  });
}
