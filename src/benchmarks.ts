import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processLock } from "@earendil-works/chord/node";
import { runRefinement, type AgentCall, type RunOptions } from "./core.js";
import { runProcess } from "./process.js";
import { seededOrder } from "./random.js";
import { writeJson } from "./storage.js";

export const UPSTREAM_REVISION = "1cfe254e8d25b15f37048c3730134686abe60335";
export const BENCHMARKS = ["jb", "lab", "wb-office", "wb-web", "wb-code"] as const;
export type Benchmark = typeof BENCHMARKS[number];
export interface BenchmarkTask { id: string; domain: string; prompt: string; guidance: string }
export interface Catalog { benchmark: Benchmark; revision: string; tasks: BenchmarkTask[] }
export type Backend = <T = any>(action: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 20);
export async function readJson<T = any>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function pythonBackend(upstream: string, signal?: AbortSignal): Backend {
  const script = fileURLToPath(new URL("../benchmark/official/bridge.py", import.meta.url));
  return async (action, args, stageSignal) => {
    const temp = await mkdtemp(join(tmpdir(), "pi2-bridge-"));
    try {
      await writeJson(join(temp, "request.json"), { ...args, action, upstream: resolve(upstream), revision: UPSTREAM_REVISION,
        node: process.execPath, worker: fileURLToPath(new URL("./worker.js", import.meta.url)) });
      const log = await runProcess(process.env.PI2_PYTHON ?? "python3", [script, join(temp, "request.json"), join(temp, "response.json")], { signal: AbortSignal.any([...(signal ? [signal] : []), ...(stageSignal ? [stageSignal] : [])]) });
      if (log.trim()) process.stderr.write(log);
      const result = await readJson(join(temp, "response.json"));
      if (result === undefined) throw new Error("Benchmark bridge produced no response");
      return result;
    } finally { await rm(temp, { recursive: true, force: true }); }
  };
}
export interface Partition { benchmark: string; seed: number; train: string[]; test: string[] }
export function partition(catalog: Catalog, seed: number, fraction = 0.8): Partition {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) throw new Error("Train fraction must be between 0 and 1");
  const result: Partition = { benchmark: catalog.benchmark, seed, train: [], test: [] };
  for (const domain of [...new Set(catalog.tasks.map(t => t.domain))].sort()) {
    const tasks = seededOrder(catalog.tasks.filter(t => t.domain === domain), `${seed}|${domain}`, t => t.id);
    const cut = tasks.length > 1 ? Math.max(1, Math.min(tasks.length - 1, Math.floor(tasks.length * fraction))) : 1;
    result.train.push(...tasks.slice(0, cut).map(t => t.id)); result.test.push(...tasks.slice(cut).map(t => t.id));
  }
  return result;
}
export function selectTasks(catalog: Catalog, options: { partition?: Partition; split?: string; domains?: string[]; tasks?: string[]; seed: number; limit?: number }): BenchmarkTask[] {
  const split = options.split ?? "all";
  if (!["all", "train", "test"].includes(split)) throw new Error("Split must be all, train, or test");
  if (split !== "all" && !options.partition) throw new Error("Train/test selection requires --split-file");
  let tasks = catalog.tasks;
  if (options.partition) {
    const p = options.partition;
    if (p.benchmark !== catalog.benchmark || !Array.isArray(p.train) || !Array.isArray(p.test)) throw new Error("Invalid split file or benchmark mismatch");
    const all = [...p.train, ...p.test];
    if (new Set(all).size !== all.length || all.some(id => !tasks.some(t => t.id === id))) throw new Error("Split contains duplicates, overlap, or unknown tasks");
    const chosen = split === "all" ? all : p[split as "train" | "test"];
    tasks = tasks.filter(t => chosen.includes(t.id));
  }
  for (const domain of options.domains ?? []) if (!catalog.tasks.some(t => t.domain === domain)) throw new Error(`Unknown domain: ${domain}`);
  for (const id of options.tasks ?? []) if (!tasks.some(t => t.id === id)) throw new Error(`Task not present in selected split: ${id}`);
  tasks = tasks.filter(t => (!options.domains?.length || options.domains.includes(t.domain)) && (!options.tasks?.length || options.tasks.includes(t.id)));
  tasks = seededOrder(tasks, String(options.seed), t => t.id);
  if (options.limit !== undefined) tasks = tasks.slice(0, options.limit);
  if (!tasks.length) throw new Error("No tasks selected");
  return tasks;
}
export interface ExperimentOptions extends Pick<RunOptions, "model" | "improverModel" | "thinkingLevel" | "harness" | "k" | "mode" | "timeoutMs" | "signal"> {
  benchmark: Benchmark; root: string; seed: number; workers: number; stageWorkers?: number; split?: string;
  partition?: Partition; domains?: string[]; tasks?: string[]; limit?: number;
  onProgress?: (message: string) => void;
}
export interface Experiment { version: number; benchmark: Benchmark; config: unknown; tasks: BenchmarkTask[]; directory: string }
export async function runExperiment(options: ExperimentOptions, backend: Backend, call: AgentCall): Promise<string> {
  const catalog = await backend<Catalog>("catalog", { benchmark: options.benchmark });
  const tasks = selectTasks(catalog, options);
  const config = { revision: catalog.revision, benchmark: options.benchmark, model: options.model, improverModel: options.improverModel,
    thinkingLevel: options.thinkingLevel, seed: options.seed, k: options.k ?? 1, mode: options.mode ?? "parallel", harness: options.harness ?? {},
    timeoutMs: options.timeoutMs ?? 600000, split: options.split ?? "all", partition: options.partition ?? null, tasks };
  const dir = join(resolve(options.root), `${options.benchmark}-${hash(config)}`);
  await mkdir(dir, { recursive: true });
  const unlock = await processLock(`pi2-experiment:${dir}`);
  try {
    await writeJson(join(dir, "experiment.json"), { version: 1, benchmark: options.benchmark, config, tasks, directory: dir } satisfies Experiment);
    const domains = [...new Set(tasks.map(t => t.domain))];
    let next = 0;
    const errors: string[] = [];
    await Promise.all(Array.from({ length: Math.min(options.workers, domains.length) }, async () => {
      while (next < domains.length && !options.signal?.aborted) {
        const domain = domains[next++];
        // One ordered learning stream per domain; other domains can progress independently.
        for (const task of tasks.filter(t => t.domain === domain)) {
          const recordDir = join(dir, "tasks", hash(task.id));
          await mkdir(recordDir, { recursive: true });
          const saved = await readJson(join(recordDir, "run.json"));
          if (saved?.status === "completed") continue;
          const cwd = join(dir, "inputs", hash(task.id));
          try {
            options.signal?.throwIfAborted();
            await backend("prepare", { benchmark: options.benchmark, task: task.id, cwd });
            const wrapped: AgentCall = async request => {
              if (!request.tools) return call(request);
              const response = options.benchmark.startsWith("wb-")
                ? await backend("execute", { benchmark: options.benchmark, task: task.id, request: { ...request, signal: undefined },
                  model: options.model, thinkingLevel: options.thinkingLevel, timeout: (options.timeoutMs ?? 600000) / 1000 }, request.signal)
                : await call(request);
              await backend("render", { benchmark: options.benchmark, task: task.id, cwd: request.cwd }, request.signal);
              return response;
            };
            const result = await runRefinement({ ...options, task: task.prompt, guidance: task.guidance, domain,
              cwd, stateDir: join(dir, "domains", hash(domain)), workers: options.stageWorkers ?? 2,
              resume: saved?.runDir, tolerateExecutionFailures: true,
              onProgress: async (stage, runDir) => {
                // Persist the resume pointer before any stage is dispatched.
                await writeJson(join(recordDir, "run.json"), { status: "running", task: task.id, domain, runDir });
                options.onProgress?.(`${task.id}: ${stage}`);
              },
            }, wrapped);
            await writeJson(join(recordDir, "run.json"), { status: "completed", task: task.id, domain, runDir: result.runDir, result });
          } catch (error) {
            errors.push(`${task.id}: ${String(error)}`);
            await writeJson(join(recordDir, "failure.json"), { error: String(error) });
            // Never let a later task teach the library before a failed predecessor is resumed.
            break;
          }
        }
      }
    }));
    if (errors.length) throw new Error(`Experiment incomplete: ${dir}\n${errors.join("\n")}`);
    options.signal?.throwIfAborted();
    return dir;
  } finally { await unlock(); }
}

export interface Score { n_passed: number; n_criteria: number; all_pass: boolean; raw_score?: number }
interface ReportRow {
  task: string; domain: string; status: string; baseline: number | null; baselineScored: number; baselineExpected: number;
  baselineAllPass: number | null; selected: number | null; selectedAllPass: boolean | null;
  usd: number | null; inputTokens: number; outputTokens: number; fallbacks: number;
  judgeConsistent: boolean;
}
export async function judgeExperiment(dir: string, backend: Backend, onProgress?: (message: string) => void) {
  const experiment = await readJson<Experiment>(join(dir, "experiment.json"));
  if (!experiment) throw new Error("No experiment.json found");
  const unlock = await processLock(`pi2-experiment:${resolve(dir)}`);
  try {
    const judge = await backend("judge-info", { benchmark: experiment.benchmark });
    for (const task of experiment.tasks) {
      const recordDir = join(dir, "tasks", hash(task.id));
      const record = await readJson(join(recordDir, "run.json"));
      if (record?.status !== "completed") continue;
      await mkdir(join(recordDir, "scores"), { recursive: true });
      const stages = (await readdir(record.runDir)).filter(name => /^(baseline|probe-general|probe-task|composed)(-\d+)?$/.test(name)).sort();
      for (const stage of stages) {
        const scoreFile = join(recordDir, "scores", `${stage}.json`);
        const previous = await readJson(scoreFile);
        if (previous?.score !== null && previous?.score !== undefined && hash(previous.judge) === hash(judge)) continue;
        onProgress?.(`${task.id}: judge ${stage}`);
        let score: Score | null = null, error: string | undefined;
        try {
          if ((await readJson(join(record.runDir, stage, "status.json")))?.status !== "completed") throw new Error("Execution did not complete");
          score = await backend<Score | null>("score", { benchmark: experiment.benchmark, task: task.id,
            cwd: join(record.runDir, stage, "workspace"), artifactDir: join(record.runDir, stage), scoreDir: join(recordDir, "judges", hash(judge), stage) });
          if (score && (!Number.isFinite(score.n_passed) || !Number.isFinite(score.n_criteria) || score.n_criteria <= 0)) throw new Error("Judge returned an invalid score");
        } catch (failure) { error = String(failure); score = null; }
        await writeJson(scoreFile, { task: task.id, stage, score, error, judge });
      }
    }
  } finally { await unlock(); }
}
export async function reportExperiment(dir: string) {
  const experiment = await readJson<Experiment>(join(dir, "experiment.json"));
  if (!experiment) throw new Error("No experiment.json found");
  const rows: ReportRow[] = [];
  for (const task of experiment.tasks) {
    const recordDir = join(dir, "tasks", hash(task.id));
    const record = await readJson(join(recordDir, "run.json"));
    const scores: Record<string, Score | null> = {};
    const judges: Record<string, string> = {};
    for (const file of await readdir(join(recordDir, "scores")).catch(() => [] as string[])) {
      const item = await readJson(join(recordDir, "scores", file)); if (item) { scores[item.stage] = item.score; judges[item.stage] = hash(item.judge); }
    }
    const baseline = Object.entries(scores).filter(([s]) => s.startsWith("baseline")).map(([, s]) => s);
    const usable = baseline.filter((s): s is Score => s !== null);
    const final: Score | null = scores[record?.result?.adopted] ?? null;
    let usd: number | null = 0, input = 0, output = 0, fallbacks = 0, ledgers = 0;
    if (record?.runDir) for (const stage of await readdir(record.runDir)) {
      if (stage.endsWith("-fallback.json")) fallbacks++;
      const stageDir = join(record.runDir, stage);
      const archives = (await readdir(stageDir).catch(() => [] as string[])).filter(n => n.startsWith("abandoned-"));
      for (const ledgerDir of [stageDir, ...archives.map(n => join(stageDir, n))]) {
        const usage = await readJson(join(ledgerDir, "usage.json")).catch(() => undefined);
        if (!usage) {
          if (await readJson(join(ledgerDir, "request.json")).catch(() => undefined)) usd = null;
          continue;
        }
        ledgers++;
        for (const u of [...Object.values(usage.models ?? {}), ...Object.values(usage.tools ?? {})] as any[]) {
          usd = usd !== null && Number.isFinite(u.cost?.total) ? usd + u.cost.total : null;
          input += u.input ?? 0; output += u.output ?? 0;
        }
      }
    }
    const base = usable.length ? usable.reduce((n, s) => n + (s.raw_score ?? s.n_passed / s.n_criteria), 0) / usable.length : null;
    rows.push({ task: task.id, domain: task.domain, status: record?.status ?? "pending", baseline: base,
      baselineScored: usable.length, baselineExpected: (experiment.config as any).k, baselineAllPass: usable.length ? usable.filter(s => s.all_pass).length / usable.length : null,
      selected: final ? final.raw_score ?? final.n_passed / final.n_criteria : null, selectedAllPass: final?.all_pass ?? null, usd: ledgers ? usd : null, inputTokens: input, outputTokens: output, fallbacks,
      judgeConsistent: Object.entries(judges).filter(([stage]) => stage.startsWith("baseline")).every(([, judge]) => judge === judges[record?.result?.adopted]) });
  }
  const aggregate = (selected: typeof rows) => {
    const paired = selected.filter(r => r.baseline !== null && r.baselineScored === r.baselineExpected && r.selected !== null && r.judgeConsistent);
    const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return { tasks: selected.length, completed: selected.filter(r => r.status === "completed").length, paired: paired.length,
      baseline: mean(paired.map(r => r.baseline!)), selected: mean(paired.map(r => r.selected!)),
      baselineAllPass: mean(paired.map(r => r.baselineAllPass!)), selectedAllPass: mean(paired.map(r => Number(r.selectedAllPass))),
      delta: mean(paired.map(r => r.selected! - r.baseline!)), usd: selected.every(r => r.usd !== null) ? selected.reduce((s, r) => s + r.usd!, 0) : null };
  };
  const report = { benchmark: experiment.benchmark, experiment: resolve(dir), costScope: "Estimated agent usage, including subagents and archived container attempts; excludes official judge charges", total: aggregate(rows),
    domains: Object.fromEntries([...new Set(rows.map(r => r.domain))].map(d => [d, aggregate(rows.filter(r => r.domain === d))])), rows };
  await writeJson(join(dir, "report.json"), report);
  return report;
}
