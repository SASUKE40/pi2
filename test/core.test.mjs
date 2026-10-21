import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runRefinement } from "../dist/core.js";
import { copyWorkspace, readMemory } from "../dist/storage.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi2-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  await mkdir(cwd);
  await writeFile(join(cwd, "ledger.txt"), "100\n-20\n5\n");
  return { root, cwd, stateDir, task: "Sum every signed amount in ledger.txt and write total.txt." };
}

function deterministicAgent(seen, reflect = { lesson: "Include credits when summing signed ledgers", evidence: "probe-general and composed included -20, omitted by baseline" }) {
  return async (request) => {
    seen.push(request);
    if (request.tools) {
      const source = await readFile(join(request.cwd, "ledger.txt"), "utf8");
      assert.equal(source, "100\n-20\n5\n", "every execution must start from the same input");
      const values = source.trim().split("\n").map(Number);
      const sum = values.filter((value) => request.instructions.includes("signed") || value > 0).reduce((a, b) => a + b, 0);
      await writeFile(join(request.cwd, "total.txt"), String(sum));
      await writeFile(join(request.cwd, "ledger.txt"), "changed during execution");
      return { text: `Total: ${sum}`, trace: `Read ledger.txt: ${source}\nWrote total.txt: ${sum}` };
    }
    const value = request.stage === "reflect" ? reflect : {
      instructions: request.stage === "propose-task" ? "Use two decimal places" : "Include every signed amount",
      rationale: "The baseline omitted the credit",
    };
    return { text: JSON.stringify(value), trace: request.stage };
  };
}

test("four isolated executions, composition evidence, and learning across tasks", async (t) => {
  const options = await fixture(t);
  await mkdir(join(options.cwd, ".git"));
  await writeFile(join(options.cwd, ".git", "config"), "must not be copied");
  await symlink(".git", join(options.cwd, "git-alias"));
  const seen = [];
  const call = deterministicAgent(seen);
  const result = await runRefinement(options, call);
  assert.equal(result.answer, "Total: 85");
  assert.equal(await readFile(join(result.outputDir, "total.txt"), "utf8"), "85");
  assert.equal(await readFile(join(options.cwd, "ledger.txt"), "utf8"), "100\n-20\n5\n");
  assert.deepEqual((await readdir(options.cwd)).sort(), [".git", "git-alias", "ledger.txt"]);
  assert.deepEqual(seen.map((request) => request.stage).sort(), ["baseline", "propose-general", "propose-task", "probe-general", "probe-task", "compose", "composed", "reflect"].sort());
  assert.equal(new Set(seen.map((request) => request.cwd)).size, 8);
  for (const request of seen.filter((request) => request.tools)) {
    await assert.rejects(readFile(join(request.cwd, ".git", "config")), { code: "ENOENT" });
    await assert.rejects(readFile(join(request.cwd, "git-alias", "config")), { code: "ENOENT" });
  }
  const compose = seen.find((request) => request.stage === "compose");
  assert.match(compose.prompt, /probe-general/);
  assert.match(compose.prompt, /probe-task/);
  assert.match(compose.prompt, /Total: 105/);
  assert.match(compose.prompt, /Total: 85/);
  const firstMemory = await readMemory(join(result.libraryDir, "memory.jsonl"));
  assert.equal(firstMemory.length, 1);
  assert.equal(firstMemory[0].instructions, result.instructions);
  assert.equal(JSON.parse(await readFile(join(result.runDir, "status.json"), "utf8")).status, "completed");

  seen.length = 0;
  const second = await runRefinement(options, call);
  assert.notEqual(second.runDir, result.runDir);
  assert.equal(seen[0].instructions, "", "learning must not silently replace the baseline");
  assert.equal(seen[0].prompt, options.task);
  assert.match(seen[1].prompt, /Include credits when summing signed ledgers/);
  assert.equal((await readMemory(join(second.libraryDir, "memory.jsonl"))).length, 2);
});

test("null reflection preserves history; only the five latest entries reach editors", async (t) => {
  const options = await fixture(t);
  await mkdir(options.stateDir);
  const entries = Array.from({ length: 7 }, (_, index) => ({ runId: `prior-${index}`, instructions: "", lesson: `lesson-${index}`, evidence: "observed" }));
  const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const first = await runRefinement(options, deterministicAgent([], null));
  const path = join(first.libraryDir, "memory.jsonl");
  await writeFile(path, original);
  const seen = [];
  const result = await runRefinement(options, deterministicAgent(seen, null));
  assert.equal(result.learned, false);
  assert.equal(await readFile(path, "utf8"), original);
  assert.doesNotMatch(seen[1].prompt, /lesson-0|lesson-1/);
  assert.match(seen[1].prompt, /lesson-2/);
  assert.match(seen[1].prompt, /lesson-6/);
});

for (const stage of ["baseline", "probe-general", "composed", "reflect"]) {
  test(`${stage} failure preserves history and records partial artifacts`, async (t) => {
    const options = await fixture(t);
    await mkdir(options.stateDir);
    const path = join(options.stateDir, "memory.jsonl");
    await writeFile(path, "");
    const agent = deterministicAgent([]);
    await assert.rejects(runRefinement(options, (request) => {
      if (request.stage === stage) throw new Error("simulated model failure");
      return agent(request);
    }), new RegExp(`${stage}: simulated model failure`));
    assert.equal(await readFile(path, "utf8"), "");
    const [run] = await readdir(join(options.stateDir, "runs"));
    const status = JSON.parse(await readFile(join(options.stateDir, "runs", run, "status.json"), "utf8"));
    assert.equal(status.status, "failed");
    assert.match(status.error, new RegExp(stage));
    if (stage === "reflect") {
      assert.equal(await readFile(join(options.stateDir, "runs", run, "composed", "answer.txt"), "utf8"), "Total: 85");
    }
  });
}

test("malformed proposals retry once and fall back to the current harness", async t => {
  const options = await fixture(t);
  const seen = [];
  const agent = deterministicAgent(seen);
  let malformed = 0;
  const result = await runRefinement(options, request => {
    if (request.stage.startsWith("propose-general")) {
      malformed++;
      return Promise.resolve({ text: '{"instructions":42}', trace: "bad schema" });
    }
    return agent(request);
  });
  assert.equal(malformed, 2);
  assert.equal(seen.find(r => r.stage === "probe-general").instructions, "");
  assert.ok(await readFile(join(result.runDir, "propose-general-fallback.json")));
});

test("timeout and cancellation abort active calls without learning", async (t) => {
  for (const kind of ["timeout", "cancel"]) {
    const options = await fixture(t);
    const controller = new AbortController();
    let aborted = false;
    await assert.rejects(runRefinement({ ...options, timeoutMs: 30, signal: controller.signal }, async (request) => {
      if (kind === "cancel") setTimeout(() => controller.abort(new Error("cancelled by user")), 5);
      return new Promise((_, reject) => request.signal.addEventListener("abort", () => {
        aborted = true;
        reject(request.signal.reason);
      }, { once: true }));
    }), kind === "timeout" ? /timed out/ : /cancelled by user/);
    assert.equal(aborted, true);
    await assert.rejects(readFile(join(options.stateDir, "memory.jsonl")), { code: "ENOENT" });
  }
});

test("state nested inside the input is excluded from snapshots", async (t) => {
  const options = await fixture(t);
  options.stateDir = join(options.cwd, ".pi2");
  const result = await runRefinement(options, deterministicAgent([]));
  assert.deepEqual(await readdir(join(result.runDir, "input")), ["ledger.txt"]);
});

test("copy rebases internal symlinks and rejects external links and cycles", async (t) => {
  const { root, cwd } = await fixture(t);
  await symlink("ledger.txt", join(cwd, "alias.txt"));
  await copyWorkspace(cwd, join(root, "copy"));
  await writeFile(join(root, "copy", "alias.txt"), "different");
  assert.equal(await readFile(join(cwd, "ledger.txt"), "utf8"), "100\n-20\n5\n");
  assert.equal(await readFile(join(root, "copy", "ledger.txt"), "utf8"), "different");
  await symlink(root, join(cwd, "outside"));
  await assert.rejects(copyWorkspace(cwd, join(root, "external-copy")), /External symlink/);
  await rm(join(cwd, "outside"));
  await symlink(".", join(cwd, "cycle"));
  await assert.rejects(copyWorkspace(cwd, join(root, "cycle-copy")), /Symlink cycle/);
});

test("copied npm-style executables resolve their own relative dependencies", async (t) => {
  const { root, cwd } = await fixture(t);
  await mkdir(join(cwd, "node_modules", "example", "bin"), { recursive: true });
  await mkdir(join(cwd, "node_modules", "example", "lib"));
  await mkdir(join(cwd, "node_modules", ".bin"));
  await writeFile(join(cwd, "node_modules", "example", "bin", "tool.cjs"), 'require("../lib/run.cjs")');
  await writeFile(join(cwd, "node_modules", "example", "lib", "run.cjs"), 'console.log("tool works")');
  // Absolute internal links must also point into the new copy.
  await symlink(join(cwd, "node_modules", "example", "bin", "tool.cjs"), join(cwd, "node_modules", ".bin", "tool"));
  const copied = join(root, "copy");
  await copyWorkspace(cwd, copied);
  await rm(join(cwd, "node_modules"), { recursive: true });
  const result = spawnSync(process.execPath, [join(copied, "node_modules", ".bin", "tool")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "tool works");
});

test("reject state roots that would swallow the input workspace", async (t) => {
  const options = await fixture(t);
  await assert.rejects(runRefinement({ ...options, stateDir: options.cwd }, deterministicAgent([])), /must not be the workspace/);
});

for (const mode of ["parallel", "sequential"]) {
  test(`${mode} recursion uses k references, k compositions and a finals-only selector`, async t => {
    const options = await fixture(t);
    const seen = [];
    const agent = deterministicAgent(seen);
    const result = await runRefinement({ ...options, k: 2, mode }, async request => {
      if (request.stage === "select") {
        seen.push(request);
        assert.equal(await readFile(join(request.evidenceDir, "candidate-2-workspace", "total.txt"), "utf8"), "85");
        assert.doesNotMatch(request.prompt, /composed-[12]|baseline/);
        await assert.rejects(readFile(join(request.evidenceDir, "candidate-2-workspace", ".pi2-harness", "systemprompt.md")), { code: "ENOENT" });
        return { text: '{"id":"B","reason":"verified output"}', trace: "selection" };
      }
      return agent(request);
    });
    assert.equal(seen.filter(r => r.tools).length, 8);
    assert.equal(seen.filter(r => !r.tools).length, 8); // 6 edits + selector + reflection
    const mapping = JSON.parse(await readFile(join(result.runDir, "selection-map.json"), "utf8"));
    assert.equal(result.adopted, mapping.B);
    if (mode === "sequential") {
      const second = seen.find(r => r.stage === "propose-general-2");
      assert.match(second.prompt, /composed-1/);
      assert.match(second.prompt, /Current harness:.*Include every signed amount/);
    } else {
      assert.doesNotMatch(seen.find(r => r.stage === "propose-general-2").prompt, /composed-1/);
    }
  });
}

test("benchmark mode records failed probes but only adopts completed finals", async t => {
  const options = await fixture(t);
  const seen = [];
  const call = deterministicAgent(seen);
  const result = await runRefinement({ ...options, tolerateExecutionFailures: true }, request => {
    if (request.stage === "probe-general") throw new Error("solver transport failed");
    return call(request);
  });
  assert.equal(result.adopted, "composed");
  assert.match(seen.find(r => r.stage === "compose").prompt, /solver transport failed/);
  const failure = JSON.parse(await readFile(join(result.runDir, "probe-general", "status.json"), "utf8"));
  assert.equal(failure.status, "failed");
});

test("resume retains snapshot, skips committed stages, rejects incompatible config and learns once", async t => {
  const options = await fixture(t);
  let resume;
  const seen = [];
  const agent = deterministicAgent(seen);
  await assert.rejects(runRefinement({ ...options, onProgress: (_, dir) => { resume = dir; } }, request => {
    if (request.stage === "compose") throw new Error("process stopped");
    return agent(request);
  }), /process stopped/);
  await writeFile(join(options.cwd, "ledger.txt"), "new original inputs");
  seen.length = 0;
  const result = await runRefinement({ ...options, resume }, agent);
  assert.deepEqual(seen.map(r => r.stage), ["compose", "composed", "reflect"]);
  assert.equal(result.answer, "Total: 85");
  assert.equal((await readMemory(join(result.libraryDir, "memory.jsonl"))).length, 1);
  await assert.rejects(runRefinement({ ...options, resume, k: 2 }, agent), /configuration differs/);
  seen.length = 0;
  await runRefinement({ ...options, resume }, agent);
  assert.equal(seen.length, 0);
  assert.equal((await readMemory(join(result.libraryDir, "memory.jsonl"))).length, 1);
});

test("editors can read full evidence and actual artifacts; domain/model histories stay separate", async t => {
  const options = await fixture(t);
  const seen = [];
  const agent = deterministicAgent(seen);
  const first = await runRefinement({ ...options, domain: "finance", model: "a/model" }, agent);
  const compose = seen.find(r => r.stage === "compose");
  assert.equal(await readFile(join(compose.evidenceDir, "baseline-workspace", "total.txt"), "utf8"), "105");
  assert.match(await readFile(join(compose.evidenceDir, "INDEX.md"), "utf8"), /complete trace/);
  for (const changes of [{ domain: "other", model: "a/model" }, { domain: "finance", model: "b/model" }]) {
    seen.length = 0;
    const other = await runRefinement({ ...options, ...changes }, agent);
    assert.notEqual(other.libraryDir, first.libraryDir);
    assert.match(seen.find(r => r.stage === "propose-general").prompt, /"priorLessons": \[\]/);
  }
});

test("invalid selection and reflection retry then retain a final without inventing a lesson", async t => {
  const options = await fixture(t);
  const agent = deterministicAgent([]);
  const stages = [];
  const result = await runRefinement({ ...options, k: 2 }, request => {
    if (/^(select|reflect)/.test(request.stage)) {
      stages.push(request.stage);
      return Promise.resolve({ text: "invalid JSON", trace: "bad output" });
    }
    return agent(request);
  });
  assert.equal(result.adopted, "composed-1");
  assert.equal(result.learned, false);
  assert.deepEqual(stages, ["select", "select-retry", "reflect", "reflect-retry"]);
  assert.ok(await readFile(join(result.runDir, "reflect-fallback.json")));
});
