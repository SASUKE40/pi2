import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { hash, judgeExperiment, partition, reportExperiment, runExperiment, selectTasks } from "../dist/benchmarks.js";
import { writeJson } from "../dist/storage.js";

const catalog = { benchmark: "lab", revision: "fixture1", tasks: [
  { id: "a/one", domain: "a", prompt: "a/one", guidance: "one", leakGlobs: ["task.json"], deliverables: "names" },
  { id: "a/two", domain: "a", prompt: "a/two", guidance: "two" },
  { id: "b/one", domain: "b", prompt: "b/one", guidance: "three" },
] };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi2-official-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = async (action, args) => {
    if (action === "catalog") return catalog;
    if (action === "judge-info") return { model: "fixture-judge" };
    if (action === "prepare") {
      await mkdir(join(args.cwd, "output"), { recursive: true });
      await writeFile(join(args.cwd, "input.txt"), args.task);
      await writeFile(join(args.cwd, "task.json"), "answer key");
      return {};
    }
    if (action === "render") { await writeFile(join(args.cwd, "deliverables.txt"), "Rendered artifact"); return {}; }
    if (action === "score") return { n_passed: args.artifactDir.endsWith("baseline") ? 1 : 2, n_criteria: 2, all_pass: !args.artifactDir.endsWith("baseline") };
    throw new Error(action);
  };
  const calls = [];
  const call = async r => {
    const task = r.tools ? r.prompt : await readFile(join(r.evidenceDir, "task.md"), "utf8");
    calls.push({ stage: r.stage, task, evidence: r.evidenceDir });
    await writeJson(join(r.artifactDir, "usage.json"), { models: { "test/model": { input: 2, output: 3, cost: { total: .1 } } }, tools: {} });
    if (r.tools) {
      await writeFile(join(r.cwd, "output", "answer.txt"), r.prompt);
      return { text: r.prompt, trace: "Executed" };
    }
    if (r.editDir) {
      await writeFile(join(r.editDir, "systemprompt.md"), "Verify output");
      return { text: "<notes>Artifact evidence</notes>", trace: "Proposed" };
    }
    return { text: "<edits>\n</edits>\n<experience>\ncue: tasks with file deliverables\nlesson: systemprompt.md: verify output\nevidence: composed wrote answer\nconfidence: low\n</experience>", trace: "Reflected" };
  };
  return { root, backend, call, calls, options: { benchmark: "lab", root, seed: 3, workers: 2, model: "test/model", k: 1 } };
}

test("stratified partitions and ordering are reproducible and reject contaminated partitions", () => {
  const a = partition(catalog, 3, .5);
  assert.deepEqual(a, partition({ ...catalog, tasks: [...catalog.tasks].reverse() }, 3, .5));
  assert.equal(new Set([...a.train, ...a.test]).size, 3);
  assert.equal(a.test.length, 1);
  assert.deepEqual(selectTasks(catalog, { seed: 3, split: "test", partition: a }).map(t => t.id), a.test);
  assert.throws(() => selectTasks(catalog, { seed: 3, split: "test" }), /requires/);
  assert.throws(() => selectTasks(catalog, { seed: 3, partition: { ...a, test: a.train } }), /overlap/);
  assert.throws(() => selectTasks(catalog, { seed: 3, tasks: ["missing"] }), /not present/);
});

test("domain sweeps learn in order, share same-domain memory, resume without calls, and isolate seeds", async t => {
  const f = await fixture(t);
  const dir = await runExperiment(f.options, f.backend, f.call);
  const manifest = JSON.parse(await readFile(join(dir, "experiment.json"), "utf8"));
  const same = manifest.tasks.filter(t => t.domain === "a");
  const first = JSON.parse(await readFile(join(dir, "tasks", hash(same[0].id), "run.json"), "utf8"));
  const second = JSON.parse(await readFile(join(dir, "tasks", hash(same[1].id), "run.json"), "utf8"));
  assert.equal(first.result.libraryDir, second.result.libraryDir);
  assert.equal(JSON.parse(await readFile(join(second.runDir, "memory-snapshot.json"), "utf8")).length, 1);
  const count = f.calls.length;
  assert.equal(await runExperiment(f.options, f.backend, f.call), dir);
  assert.equal(f.calls.length, count);
  assert.notEqual(await runExperiment({ ...f.options, seed: 4 }, f.backend, f.call), dir);
});

test("the adapter's leak globs and deliverable mode reach every editor", async t => {
  const f = await fixture(t);
  await runExperiment({ ...f.options, tasks: ["a/one"] }, f.backend, f.call);
  const compose = f.calls.find(r => r.stage === "compose");
  await assert.rejects(readFile(join(compose.evidence, "source", "task.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(compose.evidence, "source", "input.txt"), "utf8"), "a/one");
  assert.match(await readFile(join(compose.evidence, "deliverables", "baseline", "INDEX.md"), "utf8"), /output\/answer\.txt[\s\S]*withheld/);
  await assert.rejects(readFile(join(compose.evidence, "deliverables", "baseline", "output", "answer.txt")), { code: "ENOENT" });
});

test("a failed task blocks only its domain and resumes before later tasks", async t => {
  const f = await fixture(t);
  const ordered = selectTasks(catalog, f.options).filter(t => t.domain === "a");
  let broken = true;
  await assert.rejects(runExperiment(f.options, f.backend, async r => {
    if (r.stage === "reflect" && broken && (await readFile(join(r.evidenceDir, "task.md"), "utf8")).includes(ordered[0].id)) throw new Error("disconnect");
    return f.call(r);
  }), /Experiment incomplete/);
  assert.ok(!f.calls.some(r => r.stage === "baseline" && r.task === ordered[1].id));
  assert.ok(f.calls.some(r => r.stage === "reflect" && r.task.includes("b/one")));
  const count = f.calls.filter(r => r.stage === "baseline").length;
  broken = false;
  await runExperiment(f.options, f.backend, f.call);
  assert.equal(f.calls.filter(r => r.stage === "baseline").length, count + 1);
});

test("official score failures remain null, retry on judge, and reports use complete paired baselines", async t => {
  const f = await fixture(t);
  const dir = await runExperiment({ ...f.options, tasks: ["a/one"] }, f.backend, f.call);
  let failed = true, graded = 0;
  const backend = async (action, args) => {
    if (action === "score") {
      graded++;
      if (failed && args.artifactDir.endsWith("composed")) throw new Error("judge unavailable");
    }
    return f.backend(action, args);
  };
  await judgeExperiment(dir, backend);
  let report = await reportExperiment(dir);
  assert.equal(report.total.paired, 0);
  assert.equal(report.rows[0].selected, null);
  assert.equal(report.rows[0].baseline, .5);
  assert.ok(Math.abs(report.total.usd - .8) < 1e-9);
  assert.equal(graded, 4);
  failed = false;
  await judgeExperiment(dir, backend);
  assert.equal(graded, 5);
  report = await reportExperiment(dir);
  assert.equal(report.total.paired, 1);
  assert.equal(report.total.delta, .5);
  assert.equal(report.rows[0].selectedAllPass, true);
});
