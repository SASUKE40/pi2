import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runRefinement } from "../dist/core.js";
import { createPiAgent } from "../dist/pi.js";
import { tasks, grade, failedGrade } from "./tasks.mjs";

const help = `Usage: npm run bench -- [--model provider/model] [--repeats N] [--task ID]
                     [--out DIR] [--timeout SECONDS]

Compare baseline vs refined coding-task quality using the same real Pi model.
Defaults: 1 repeat, all 3 tasks, .pi2/benchmarks, 180 seconds per session.
Each attempt uses 8 agent sessions and fresh learning state. Provider charges apply.
Task IDs: ${tasks.map(t => t.id).join(", ")}
Results include held-out checks, per-stage usage, elapsed time, and failures.
This small local suite is not an official Harness2 benchmark.
`;

function summarize(results) {
  const summary = { attempts: results.length, workflowErrors: results.filter(r => r.error).length };
  for (const key of ["baseline", "refined"]) {
    summary[key] = {
      tasksPassed: results.filter(r => r[key].allPassed).length,
      checksPassed: results.reduce((n, r) => n + r[key].passed, 0),
      checksTotal: results.reduce((n, r) => n + r[key].total, 0),
    };
  }
  const pairs = results.filter(r => !r.error);
  summary.completedPairs = pairs.length;
  summary.improved = pairs.filter(r => r.refined.passed > r.baseline.passed).length;
  summary.regressed = pairs.filter(r => r.refined.passed < r.baseline.passed).length;
  summary.tied = pairs.length - summary.improved - summary.regressed;
  return summary;
}

async function usage(artifactDir) {
  try {
    const messages = JSON.parse(await readFile(join(artifactDir, "messages.json"), "utf8"));
    const replies = messages.filter(m => m.role === "assistant");
    const sum = (get) => replies.length && replies.every(m => Number.isFinite(get(m)))
      ? replies.reduce((n, m) => n + get(m), 0) : null;
    return {
      assistantMessages: replies.length,
      inputTokens: sum(m => m.usage?.input), outputTokens: sum(m => m.usage?.output),
      cacheReadTokens: sum(m => m.usage?.cacheRead), cacheWriteTokens: sum(m => m.usage?.cacheWrite),
      estimatedCostUsd: sum(m => m.usage?.cost?.total),
    };
  } catch { return { assistantMessages: null, estimatedCostUsd: null }; }
}

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Benchmark cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const { values } = parseArgs({ options: {
    model: { type: "string" }, repeats: { type: "string", default: "1" },
    task: { type: "string" }, out: { type: "string", default: ".pi2/benchmarks" },
    timeout: { type: "string", default: "180" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(help);
  } else {
    const repeats = Number(values.repeats);
    const timeoutMs = Number(values.timeout) * 1000;
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new Error("--repeats must be an integer from 1 to 100");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Invalid --timeout");
    const selected = tasks.filter(t => !values.task || t.id === values.task);
    if (!selected.length) throw new Error(`Unknown --task. Choose: ${tasks.map(t => t.id).join(", ")}`);
    // Fail before creating results when credentials/model selection are unavailable.
    const agent = await createPiAgent({ cwd: process.cwd(), model: values.model, signal: controller.signal });
    const parent = resolve(values.out);
    await mkdir(parent, { recursive: true });
    const output = await mkdtemp(join(parent, "quality-"));
    let revision = null;
    let dirty = null;
    try {
      revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
    } catch { /* Git metadata is optional. */ }
    const report = {
      suite: "pi2-coding-v1", status: "running", model: agent.model, thinkingLevel: agent.thinkingLevel, startedAt: new Date().toISOString(),
      revision, dirty, node: process.version, repeats, timeoutMs, tasks: selected.map(t => t.id),
      notes: ["Fresh state for every attempt; no cross-task learning.",
        "Grades are computed after refinement and never supplied to agents.",
        "Checks are withheld from prompts, not protected by an OS sandbox.",
        "Full workflow usage includes baseline, proposals, probes, composition, execution, reflection.",
        "Costs are Pi estimates; missing usage is null, not zero. No claim of statistical significance."],
      results: [],
    };
    const save = async () => {
      report.summary = summarize(report.results);
      await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    };
    await save();
    console.log(`Model: ${agent.model}\nReport: ${join(output, "report.json")}`);
    for (let repeat = 1; repeat <= repeats && !controller.signal.aborted; repeat++) {
      for (const task of selected) {
        if (controller.signal.aborted) break;
        const root = join(output, `${task.id}-${repeat}`);
        const cwd = join(root, "input");
        await mkdir(cwd, { recursive: true });
        await writeFile(join(cwd, task.file), `export function ${task.name}() { throw new Error("Not implemented"); }\n`);
        const stages = [];
        let runDir;
        let error;
        const start = performance.now();
        try {
          await runRefinement({ task: task.prompt, cwd, stateDir: join(root, "state"),
            model: agent.model, timeoutMs, signal: controller.signal,
            onProgress: (stage, path) => {
              runDir = path;
              process.stderr.write(`${task.id} ${repeat}/${repeats}: ${stage}\n`);
            },
          }, async request => {
            const started = performance.now();
            let success = false;
            try {
              const response = await agent.call(request);
              success = true;
              return response;
            } finally {
              stages.push({ stage: request.stage, success, seconds: (performance.now() - started) / 1000,
                ...await usage(request.artifactDir) });
            }
          });
        } catch (failure) { error = String(failure); }
        const seconds = (performance.now() - start) / 1000;
        const baseline = stages.some(s => s.stage === "baseline" && s.success)
          ? grade(task, join(runDir, "baseline", "workspace")) : failedGrade(task, "Baseline did not complete");
        const refined = !error ? grade(task, join(runDir, "composed", "workspace"))
          : failedGrade(task, "Refinement workflow did not complete");
        const cost = !error && stages.length === 8 && stages.every(s => s.estimatedCostUsd !== null)
          ? stages.reduce((n, s) => n + s.estimatedCostUsd, 0) : null;
        report.results.push({ task: task.id, repeat, runDir, error, baseline, refined,
          workflowSeconds: seconds, workflowEstimatedCostUsd: cost, stages });
        await save();
        console.log(`${task.id} #${repeat}: baseline ${baseline.passed}/${baseline.total}; refined ${refined.passed}/${refined.total}; ${seconds.toFixed(1)}s${error ? "; WORKFLOW ERROR" : ""}`);
      }
    }
    report.finishedAt = new Date().toISOString();
    report.cancelled = controller.signal.aborted;
    report.status = report.cancelled ? "cancelled" : report.results.some(r => r.error) ? "completed_with_errors" : "completed";
    await save();
    console.log(JSON.stringify(report.summary, null, 2));
    if (controller.signal.aborted) process.exitCode = 130;
    else if (report.summary.workflowErrors) process.exitCode = 1;
  }
} catch (error) {
  console.error(`benchmark: ${error instanceof Error ? error.message : error}`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
