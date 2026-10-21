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

const LESSON = { cue: "summing a ledger that mixes debits and credits", lesson: "systemprompt.md: include credits when summing signed ledgers", evidence: "probe-inv and composed included -20; baseline omitted it" };

function reflection(lesson) {
  const edits = "<edits>\ncomponent: systemprompt.md\ncandidates: probe-inv, composed\nchange: include signed amounts\nobserved: total 85 instead of 105\nverdict: helped\n</edits>";
  return lesson ? `${edits}\n\n<experience>\ncue: ${lesson.cue}\nlesson: ${lesson.lesson}\nevidence: ${lesson.evidence}\nconfidence: medium\n</experience>` : `${edits}\n\nNO_ENTRY`;
}

/** Solvers sum positives unless the harness says "signed"; editors edit context/harness/ in place. */
function deterministicAgent(seen, lesson = LESSON) {
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
    if (request.editDir) {
      const text = request.stage.startsWith("propose-dom") ? "Use two decimal places" : "Include every signed amount";
      await writeFile(join(request.editDir, "systemprompt.md"), text);
      return { text: `<notes>\nbaseline omitted the credit -> ${text}\n</notes>`, trace: request.stage };
    }
    if (request.stage.startsWith("select")) return { text: "<why>\nB is complete\n</why>\n\n```choice\nB\n```", trace: request.stage };
    return { text: reflection(lesson), trace: request.stage };
  };
}

test("isolated executions, file-based evidence, and a library that carries full harnesses", async (t) => {
  const options = await fixture(t);
  await mkdir(join(options.cwd, ".git"));
  await writeFile(join(options.cwd, ".git", "config"), "must not be copied");
  await symlink(".git", join(options.cwd, "git-alias"));
  const seen = [];
  const call = deterministicAgent(seen);
  const result = await runRefinement(options, call);
  assert.equal(result.answer, "Total: 85");
  assert.equal(result.adopted, "composed");
  assert.equal(await readFile(join(result.outputDir, "total.txt"), "utf8"), "85");
  assert.equal(await readFile(join(options.cwd, "ledger.txt"), "utf8"), "100\n-20\n5\n");
  assert.deepEqual((await readdir(options.cwd)).sort(), [".git", "git-alias", "ledger.txt"]);
  assert.deepEqual(seen.map((request) => request.stage).sort(), ["baseline", "propose-inv", "propose-dom", "probe-inv", "probe-dom", "compose", "composed", "reflect"].sort());
  assert.equal(new Set(seen.map((request) => request.cwd)).size, 8);
  for (const request of seen.filter((request) => request.tools)) {
    await assert.rejects(readFile(join(request.cwd, ".git", "config")), { code: "ENOENT" });
    await assert.rejects(readFile(join(request.cwd, "git-alias", "config")), { code: "ENOENT" });
  }
  const proposer = seen.find((request) => request.stage === "propose-inv");
  assert.match(proposer.prompt, /YOUR DIMENSION: INV/);
  assert.match(proposer.prompt, /# YOUR EVIDENCE/);
  assert.match(proposer.prompt, /context\/rollouts\/ +FULL trajectories: baseline\.md/);
  assert.equal(proposer.editDir, join(proposer.evidenceDir, "harness"));
  assert.match(seen.find((request) => request.stage === "propose-dom").prompt, /YOUR DIMENSION: DOM/);

  const compose = seen.find((request) => request.stage === "compose");
  const context = compose.evidenceDir;
  assert.match(compose.prompt, /composing THE final harness/);
  assert.match(compose.prompt, /probe-inv, probe-dom/);
  assert.match(await readFile(join(context, "rollouts", "baseline.md"), "utf8"), /Total: 105/);
  assert.equal(await readFile(join(context, "deliverables", "baseline", "total.txt"), "utf8"), "105");
  assert.match(await readFile(join(context, "pool", "probe-inv", "rollout.md"), "utf8"), /Total: 85/);
  assert.match(await readFile(join(context, "pool", "probe-inv", "harness.diff"), "utf8"), /\+Include every signed amount/);
  assert.equal(await readFile(join(context, "pool", "probe-dom", "harness", "systemprompt.md"), "utf8"), "Use two decimal places");
  assert.match(await readFile(join(context, "decisions", "propose-inv.md"), "utf8"), /baseline omitted the credit/);
  assert.equal(await readFile(join(context, "source", "ledger.txt"), "utf8"), "100\n-20\n5\n");

  const reflect = seen.find((request) => request.stage === "reflect");
  assert.equal(reflect.editDir, undefined);
  assert.equal(JSON.parse(await readFile(join(reflect.evidenceDir, "adoption.json"), "utf8")).chosen_label, "composed");
  assert.equal(await readFile(join(reflect.evidenceDir, "harness", "systemprompt.md"), "utf8"), "Include every signed amount");
  assert.match(await readFile(join(result.runDir, "edits.md"), "utf8"), /verdict: helped/);

  const firstMemory = await readMemory(join(result.libraryDir, "memory.jsonl"));
  assert.equal(firstMemory.length, 1);
  assert.deepEqual(firstMemory[0].files, result.harness);
  assert.equal(firstMemory[0].cue, LESSON.cue);
  const runId = firstMemory[0].runId;
  assert.match(await readFile(join(result.libraryDir, "INDEX.md"), "utf8"), new RegExp(`harnesses/${runId}/`));
  assert.equal(await readFile(join(result.libraryDir, "harnesses", runId, "harness", "systemprompt.md"), "utf8"), "Include every signed amount");
  assert.equal(JSON.parse(await readFile(join(result.runDir, "status.json"), "utf8")).status, "completed");

  seen.length = 0;
  const second = await runRefinement(options, call);
  assert.notEqual(second.runDir, result.runDir);
  assert.deepEqual(seen[0].harness, {}, "learning must not silently replace the baseline");
  assert.equal(seen[0].prompt, options.task);
  const next = seen.find((request) => request.stage === "propose-inv");
  assert.match(await readFile(join(next.evidenceDir, "library", "INDEX.md"), "utf8"), new RegExp(LESSON.cue));
  assert.match(await readFile(join(next.evidenceDir, "library", "harnesses", runId, "EXPERIENCE.md"), "utf8"), /include credits/);
  assert.equal((await readMemory(join(second.libraryDir, "memory.jsonl"))).length, 2);
});

test("NO_ENTRY preserves history and editors browse the whole library", async (t) => {
  const options = await fixture(t);
  const entries = Array.from({ length: 7 }, (_, index) => ({ runId: `prior-${index}`, task: "t", adopted: "composed", why: "", cue: `cue-${index}`,
    lesson: `lesson-${index}`, evidence: "observed", confidence: "low", edits: "", files: { "systemprompt.md": `prior ${index}` } }));
  const original = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const first = await runRefinement(options, deterministicAgent([], null));
  assert.equal(first.learned, false);
  const path = join(first.libraryDir, "memory.jsonl");
  await writeFile(path, original);
  const seen = [];
  const result = await runRefinement(options, deterministicAgent(seen, null));
  assert.equal(result.learned, false);
  assert.equal(await readFile(path, "utf8"), original);
  const index = await readFile(join(seen.find((request) => request.stage === "propose-inv").evidenceDir, "library", "INDEX.md"), "utf8");
  assert.match(index, /cue-0/);
  assert.match(index, /cue-6/);
});

test("an all-baseline failure stops the run with every underlying error", async (t) => {
  const options = await fixture(t);
  await assert.rejects(runRefinement(options, (request) => {
    if (request.stage === "baseline") throw new Error("simulated model failure");
    return deterministicAgent([])(request);
  }), /No baseline execution delivered anything[\s\S]*baseline: simulated model failure/);
  const [run] = await readdir(join(options.stateDir, "runs"));
  const status = JSON.parse(await readFile(join(options.stateDir, "runs", run, "status.json"), "utf8"));
  assert.equal(status.status, "failed");
  assert.ok(JSON.parse(await readFile(join(options.stateDir, "runs", run, "baseline", "failure.json"), "utf8")).error);
});

for (const stage of ["propose-inv", "compose", "reflect"]) {
  test(`${stage} transport failure preserves history and records partial artifacts`, async (t) => {
    const options = await fixture(t);
    const agent = deterministicAgent([]);
    await assert.rejects(runRefinement(options, (request) => {
      if (request.stage === stage) throw new Error("simulated model failure");
      return agent(request);
    }), new RegExp(`${stage}: simulated model failure`));
    const [run] = await readdir(join(options.stateDir, "runs"));
    const status = JSON.parse(await readFile(join(options.stateDir, "runs", run, "status.json"), "utf8"));
    assert.equal(status.status, "failed");
    assert.match(status.error, new RegExp(stage));
    const [library] = await readdir(join(options.stateDir, "libraries"));
    await assert.rejects(readFile(join(options.stateDir, "libraries", library, "memory.jsonl")), { code: "ENOENT" });
    if (stage === "reflect") {
      assert.equal(await readFile(join(options.stateDir, "runs", run, "composed", "answer.txt"), "utf8"), "Total: 85");
    }
  });
}

test("an invalid tree gets one corrective attempt with the rejected tree on disk, then falls back", async t => {
  const options = await fixture(t);
  const seen = [];
  const agent = deterministicAgent(seen);
  const result = await runRefinement(options, async request => {
    if (request.stage === "propose-inv") {
      seen.push(request);
      await mkdir(join(request.editDir, "skills", "totals"), { recursive: true });
      await writeFile(join(request.editDir, "skills", "totals", "SKILL.md"), "Sum carefully, including signed amounts.");
      return { text: "<notes>added a skill</notes>", trace: "" };
    }
    if (request.stage === "propose-inv-retry") {
      seen.push(request);
      assert.match(request.prompt, /YOUR PREVIOUS PROPOSAL WAS REJECTED[\s\S]*skills\/totals\/SKILL\.md/);
      const skill = join(request.editDir, "skills", "totals", "SKILL.md");
      await writeFile(skill, `---\ndescription: when summing a ledger with signed entries\n---\n${await readFile(skill, "utf8")}`);
      return { text: "<notes>added the description</notes>", trace: "" };
    }
    if (request.stage.startsWith("propose-dom")) {
      seen.push(request);
      await writeFile(join(request.editDir, "notes.txt"), "off the surface");
      return { text: "<notes>wrote notes</notes>", trace: "" };
    }
    return agent(request);
  });
  const probe = seen.find(r => r.stage === "probe-inv");
  assert.match(probe.harness["skills/totals/SKILL.md"], /description: when summing/);
  assert.match(probe.instructions, /`totals`: when summing a ledger with signed entries \(\.pi2-harness\/skills\/totals\/SKILL\.md\)/);
  assert.deepEqual(seen.find(r => r.stage === "probe-dom").harness, {});
  assert.equal(seen.filter(r => r.stage.startsWith("propose-dom")).length, 2);
  assert.match(JSON.parse(await readFile(join(result.runDir, "propose-dom-fallback.json"), "utf8")).error, /off the editable surface.*notes\.txt/);
  await assert.rejects(readFile(join(result.runDir, "propose-inv-fallback.json")), { code: "ENOENT" });
});

test("a named script must ship with the proposal", async t => {
  const options = await fixture(t);
  const seen = [];
  const agent = deterministicAgent(seen);
  const result = await runRefinement(options, async request => {
    if (request.stage.startsWith("propose-inv")) {
      await writeFile(join(request.editDir, "systemprompt.md"), "Run python3 .pi2-harness/scripts/total.py before answering.");
      return { text: "<notes>script</notes>", trace: "" };
    }
    return agent(request);
  });
  assert.match(JSON.parse(await readFile(join(result.runDir, "propose-inv-fallback.json"), "utf8")).error, /scripts\/total\.py/);
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
    const [library] = await readdir(join(options.stateDir, "libraries"));
    await assert.rejects(readFile(join(options.stateDir, "libraries", library, "memory.jsonl")), { code: "ENOENT" });
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
  test(`${mode} recursion uses k references, k compositions and a finals-only blind selector`, async t => {
    const options = await fixture(t);
    const seen = [];
    const agent = deterministicAgent(seen);
    const result = await runRefinement({ ...options, k: 2, mode }, async request => {
      if (request.stage === "select") {
        assert.equal(await readFile(join(request.evidenceDir, "candidates", "B", "total.txt"), "utf8"), "85");
        assert.match(await readFile(join(request.evidenceDir, "candidates", "A.md"), "utf8"), /Total: 85/);
        assert.deepEqual((await readdir(join(request.evidenceDir))).sort(), ["candidates", "source", "task.md"]);
        assert.doesNotMatch(request.prompt, /composed-[12]|baseline|probe/);
        await assert.rejects(readdir(join(request.evidenceDir, "candidates", "B", ".pi2-harness")), { code: "ENOENT" });
      }
      return agent(request);
    });
    assert.equal(seen.filter(r => r.tools).length, 8);
    assert.equal(seen.filter(r => !r.tools).length, 8); // 6 edits + selector + reflection
    const selection = JSON.parse(await readFile(join(result.runDir, "selection.json"), "utf8"));
    assert.deepEqual(selection.pool.sort(), ["composed-1", "composed-2"]);
    assert.equal(result.adopted, selection.idMap.B);
    assert.equal(selection.why, "B is complete");
    const second = seen.find(r => r.stage === "propose-inv-2");
    if (mode === "sequential") {
      assert.match(second.prompt, /This is round 2/);
      assert.equal(await readFile(join(second.evidenceDir, "harness", "systemprompt.md"), "utf8"), "Include every signed amount");
      assert.match(await readFile(join(second.evidenceDir, "pool", "composed-1", "rollout.md"), "utf8"), /Total: 85/);
      assert.match(await readFile(join(second.evidenceDir, "decisions", "compose-1.md"), "utf8"), /baseline omitted/);
    } else {
      assert.match(second.prompt, /candidate 2 of 2/);
      await assert.rejects(readdir(join(second.evidenceDir, "pool")), { code: "ENOENT" });
    }
  });
}

test("failed probes are evidence; only delivered finals are adopted", async t => {
  const options = await fixture(t);
  const seen = [];
  const call = deterministicAgent(seen);
  const result = await runRefinement(options, request => {
    if (request.stage === "probe-inv") throw new Error("solver transport failed");
    return call(request);
  });
  assert.equal(result.adopted, "composed");
  const compose = seen.find(r => r.stage === "compose");
  assert.match(await readFile(join(compose.evidenceDir, "pool", "probe-inv", "rollout.md"), "utf8"), /FAILED[\s\S]*solver transport failed/);
  assert.equal(JSON.parse(await readFile(join(result.runDir, "probe-inv", "status.json"), "utf8")).status, "failed");
});

test("when no final delivers, a delivered base rollout is adopted and recorded as such", async t => {
  const options = await fixture(t);
  const call = deterministicAgent([]);
  const result = await runRefinement(options, request => {
    if (request.stage === "composed") throw new Error("solver transport failed");
    return call(request);
  });
  assert.equal(result.adopted, "baseline");
  const selection = JSON.parse(await readFile(join(result.runDir, "selection.json"), "utf8"));
  assert.match(selection.poolKind, /baselines/);
  assert.deepEqual(selection.dropped, ["composed"]);
});

test("strict mode aborts on an execution failure", async t => {
  const options = await fixture(t);
  const call = deterministicAgent([]);
  await assert.rejects(runRefinement({ ...options, tolerateExecutionFailures: false }, request => {
    if (request.stage === "probe-dom") throw new Error("solver transport failed");
    return call(request);
  }), /probe-dom: solver transport failed/);
});

test("answer-key paths never reach editors, and grader verdicts stop the run", async t => {
  const options = await fixture(t);
  await mkdir(join(options.cwd, "tests"));
  await writeFile(join(options.cwd, "tests", "expected.txt"), "85");
  const seen = [];
  const call = deterministicAgent(seen);
  await runRefinement({ ...options, leakGlobs: ["tests/**"] }, call);
  const proposer = seen.find(r => r.stage === "propose-inv");
  await assert.rejects(readFile(join(proposer.evidenceDir, "source", "tests", "expected.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(seen.find(r => r.stage === "baseline").cwd, "tests", "expected.txt"), "utf8"), "85");

  const leaked = await fixture(t);
  await assert.rejects(runRefinement(leaked, async request => {
    if (request.stage === "baseline") await writeFile(join(request.cwd, "report.json"), '{"pass_rate": 1}');
    return call(request);
  }), /Grader verdict would enter model context/);
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
  const config = JSON.parse(await readFile(join(resume, "config.json"), "utf8"));
  await writeFile(join(resume, "config.json"), JSON.stringify({ ...config, version: 2 }));
  await assert.rejects(runRefinement({ ...options, resume }, agent), /older pi2/);
});

test("domain and model histories stay separate", async t => {
  const options = await fixture(t);
  const seen = [];
  const agent = deterministicAgent(seen);
  const first = await runRefinement({ ...options, domain: "finance", model: "a/model" }, agent);
  for (const changes of [{ domain: "other", model: "a/model" }, { domain: "finance", model: "b/model" }]) {
    seen.length = 0;
    const other = await runRefinement({ ...options, ...changes }, agent);
    assert.notEqual(other.libraryDir, first.libraryDir);
    await assert.rejects(readdir(join(seen.find(r => r.stage === "propose-inv").evidenceDir, "library")), { code: "ENOENT" });
  }
});

test("BenchPrompts guidance interpolates into every stage", async t => {
  const options = await fixture(t);
  const seen = [];
  const guidance = JSON.stringify({ work: "Ledger reconciliation for a small business.", domain_word: "bookkeeping area", deliverable_word: "ledger total",
    inv_levers: "INV-LEVER-TEXT", dom_levers: "DOM-LEVER-TEXT", domain_guidance: "LENS-TEXT", selection_checks: "CHECKS-TEXT", selection_lead: "LEAD-TEXT",
    yardstick: "", selection_conformance: "", prompt_pack: "adapt" });
  await runRefinement({ ...options, k: 2, guidance }, deterministicAgent(seen));
  const prompt = stage => seen.find(r => r.stage === stage).prompt;
  assert.match(prompt("propose-inv-1"), /Ledger reconciliation[\s\S]*LENS-TEXT[\s\S]*INV-LEVER-TEXT/);
  assert.match(prompt("propose-dom-1"), /DOM-LEVER-TEXT/);
  assert.match(prompt("propose-dom-1"), /SHAPE IT FOR THE BOOKKEEPING AREA/);
  assert.match(prompt("select"), /0\. LEAD-TEXT[\s\S]*CHECKS-TEXT/);
  assert.match(prompt("select"), /ledger total/);
  assert.match(prompt("reflect"), /LENS-TEXT/);
});

test("invalid selection and reflection retry then retain a final without inventing a lesson", async t => {
  const options = await fixture(t);
  const agent = deterministicAgent([]);
  const stages = [];
  const result = await runRefinement({ ...options, k: 2 }, request => {
    if (/^(select|reflect)/.test(request.stage)) {
      stages.push(request.stage);
      return Promise.resolve({ text: "invalid reply", trace: "bad output" });
    }
    return agent(request);
  });
  assert.equal(result.adopted, "composed-1");
  assert.equal(result.learned, false);
  assert.deepEqual(stages, ["select", "select-retry", "reflect", "reflect-retry"]);
  assert.ok(await readFile(join(result.runDir, "reflect-fallback.json")));
  assert.match(JSON.parse(await readFile(join(result.runDir, "selection.json"), "utf8")).fallback, /choice/);
});
