import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { BENCHMARKS, judgeExperiment, partition, pythonBackend, readJson, reportExperiment, runExperiment, selectTasks, type Benchmark, type Catalog } from "./benchmarks.js";
import { readHarness } from "./harness.js";
import { writeJson } from "./storage.js";

export const BENCH_HELP = `Usage: pi2 bench <setup|check|tasks|split|run|judge|report> [options]

  --benchmark NAME     jb, lab, wb-office, wb-web, wb-code
  --upstream DIR       Pinned Harness2 checkout (default: ~/.pi2/harness2)
  --root DIR           Experiment storage (default: .pi2/official)
  --experiment DIR     Existing experiment for judge/report
  --model P/M          Pi solver provider/model
  --improver-model P/M Separate improvement model
  --judge-model NAME   Official judge model (or HARNESS2_JUDGE_MODEL)
  --judge-base-url URL JobBench judge endpoint (or HARNESS2_JUDGE_BASE_URL)
  --thinking LEVEL     off, minimal, low, medium, high, xhigh
  --harness PATH       Initial harness directory or Markdown file
  --k N                Recursion budget (default 1)
  --mode MODE          parallel or sequential
  --workers N          Concurrent domains (default 1); tasks within a domain are ordered
  --stage-workers N    Concurrent stages per task (default 2)
  --seed N             Reproducible task/candidate order (default 0)
  --domain NAME        Select domain (repeatable)
  --task ID            Select task (repeatable)
  --limit N            Limit the ordered task set
  --split NAME         all, train, test (default all)
  --split-file PATH    Partition to read, or create with split
  --train-fraction N   Stratified training fraction for split (default 0.8)
  --timeout SEC        Per-stage limit (default 600)
  --dry-run            Show benchmark setup commands without installing

Repeat run with the same options to resume. Judges are invoked separately with judge.
setup installs benchmark dependencies/data; check performs no paid model calls.
WorkBuddy uses Docker and its configured model/judge routes; see benchmark/official/README.md.
`;

export async function benchCli(argv: string[], signal: AbortSignal) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    benchmark: { type: "string" }, upstream: { type: "string" }, root: { type: "string" }, experiment: { type: "string" },
    model: { type: "string" }, "improver-model": { type: "string" }, thinking: { type: "string" }, harness: { type: "string" },
    "judge-model": { type: "string" }, "judge-base-url": { type: "string" },
    k: { type: "string" }, mode: { type: "string" }, workers: { type: "string" }, "stage-workers": { type: "string" },
    seed: { type: "string" }, domain: { type: "string", multiple: true }, task: { type: "string", multiple: true }, limit: { type: "string" },
    split: { type: "string" }, "split-file": { type: "string" }, "train-fraction": { type: "string" }, timeout: { type: "string" },
    "dry-run": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (v.help) { process.stdout.write(BENCH_HELP); return; }
  if (v["judge-model"]) process.env.HARNESS2_JUDGE_MODEL = v["judge-model"];
  if (v["judge-base-url"]) process.env.HARNESS2_JUDGE_BASE_URL = v["judge-base-url"];
  const command = positionals[0];
  if (positionals.length !== 1 || !["setup", "check", "tasks", "split", "run", "judge", "report"].includes(command)) throw new Error(BENCH_HELP);
  const number = (key: "k" | "workers" | "stage-workers" | "seed" | "limit", fallback: number, min: number, max: number) => {
    const value = Number(v[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${key} must be an integer from ${min} to ${max}`);
    return value;
  };
  const seed = number("seed", 0, -2147483648, 2147483647), k = number("k", 1, 1, 20), workers = number("workers", 1, 1, 32), stageWorkers = number("stage-workers", 2, 1, 32);
  const mode = v.mode ?? "parallel", thinking = v.thinking ?? "medium", timeout = Number(v.timeout ?? 600);
  if (!["parallel", "sequential"].includes(mode)) throw new Error("Invalid --mode");
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)) throw new Error("Invalid --thinking");
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647) throw new Error("Invalid --timeout");
  const backend = pythonBackend(v.upstream ?? join(homedir(), ".pi2", "harness2"), signal);
  const progress = (message: string) => process.stderr.write(message + "\n");
  if (["judge", "report"].includes(command)) {
    if (!v.experiment) throw new Error("--experiment DIR is required");
    const dir = resolve(v.experiment);
    if (command === "judge") await judgeExperiment(dir, backend, progress);
    process.stdout.write(JSON.stringify(await reportExperiment(dir), null, 2) + "\n");
    return;
  }
  if (!BENCHMARKS.includes(v.benchmark as Benchmark)) throw new Error(`--benchmark must be ${BENCHMARKS.join(", ")}`);
  const benchmark = v.benchmark as Benchmark;
  if (command === "setup" || command === "check") {
    const result = await backend(command, { benchmark, dryRun: v["dry-run"] ?? false });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (command === "check" && !result.ok) process.exitCode = 1;
    return;
  }
  const selected = { seed, split: v.split ?? "all", partition: v["split-file"] && command !== "split" ? await readJson(resolve(v["split-file"])) : undefined,
    domains: v.domain, tasks: v.task, limit: v.limit ? number("limit", 1, 1, Number.MAX_SAFE_INTEGER) : undefined };
  if (v["split-file"] && command !== "split" && !selected.partition) throw new Error("Split file does not exist");
  if (command === "run") {
    const { createPiAgent } = await import("./pi.js");
    const checked = await backend("check", { benchmark });
    if (!checked.ok) throw new Error(`Benchmark preflight failed: ${JSON.stringify(checked)}`);
    const agent = await createPiAgent({ cwd: process.cwd(), model: v.model, improverModel: v["improver-model"], thinkingLevel: thinking as ModelThinkingLevel, signal });
    const dir = await runExperiment({ ...selected, benchmark, root: v.root ?? ".pi2/official", model: agent.model, improverModel: agent.improverModel,
      thinkingLevel: agent.thinkingLevel, harness: v.harness ? await readHarness(v.harness) : undefined, k, mode: mode as "parallel" | "sequential",
      workers, stageWorkers, timeoutMs: timeout * 1000, signal, onProgress: progress }, backend, agent.call);
    process.stdout.write(`Experiment: ${dir}\nNext: pi2 bench judge --experiment ${JSON.stringify(dir)}\n`);
    return;
  }
  const catalog = await backend<Catalog>("catalog", { benchmark });
  if (command === "tasks") process.stdout.write(JSON.stringify(selectTasks(catalog, selected), null, 2) + "\n");
  else {
    if (!v["split-file"]) throw new Error("split requires --split-file PATH");
    if (await readJson(resolve(v["split-file"]))) throw new Error("Split file already exists; choose a new path");
    const result = partition(catalog, seed, Number(v["train-fraction"] ?? 0.8));
    await mkdir(dirname(resolve(v["split-file"])), { recursive: true });
    await writeJson(resolve(v["split-file"]), result);
    process.stdout.write(`Split: ${resolve(v["split-file"])} (${result.train.length} train, ${result.test.length} test)\n`);
  }
}
