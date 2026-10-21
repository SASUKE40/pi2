import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { processLock } from "@earendil-works/chord/node";
import { buildContext, producedFiles, walk, type ContextSpec, type DeliverableMode, type Evidence } from "./evidence.js";
import {
  checkHarness, GRADER_MARKERS, HARNESS_ROOT, harnessInstructions, normalizeHarness, readTree, sameHarness, validateHarness,
  writeHarness, type HarnessFiles,
} from "./harness.js";
import { renderLibrary } from "./library.js";
import {
  aggregate, benchPrompts, composeRound, EDITOR_SYSTEM, experience, mission, parseChoice, parseNotes, parseReflection, propose,
  READER_SYSTEM, select, selectMission, SOLVER_SYSTEM, type Dimension, type Experience,
} from "./prompts.js";
import { seededOrder } from "./random.js";
import { appendMemory, contains, copyWorkspace, readMemory, writeJson, type MemoryEntry } from "./storage.js";

export type { Evidence } from "./evidence.js";
export interface AgentRequest {
  stage: string; cwd: string; artifactDir: string; prompt: string; instructions: string;
  tools: boolean; signal: AbortSignal; harness?: HarnessFiles;
  /** Read-only evidence root for improvement sessions. */
  evidenceDir?: string;
  /** Writable harness tree for editing sessions; always inside evidenceDir. */
  editDir?: string;
}
export interface AgentResponse { text: string; trace: string }
/** Calls must honor signal and join active work before returning. */
export type AgentCall = (request: AgentRequest) => Promise<AgentResponse>;
export interface RunOptions {
  task: string; cwd: string; stateDir: string; instructions?: string; harness?: HarnessFiles;
  timeoutMs?: number; signal?: AbortSignal; model?: string; improverModel?: string; thinkingLevel?: string;
  k?: number; mode?: "parallel" | "sequential"; workers?: number; domain?: string; resume?: string;
  seed?: number; guidance?: string; tolerateExecutionFailures?: boolean;
  /** Workspace paths (fnmatch-style) that must never enter an editor's or selector's context. */
  leakGlobs?: string[];
  /** Whether editors see produced files or only their names. */
  deliverables?: DeliverableMode;
  onProgress?: (stage: string, runDir: string) => void | Promise<void>;
}
export interface RunResult {
  runDir: string; outputDir: string; answer: string; instructions: string; harness: HarnessFiles;
  learned: boolean; libraryDir: string; adopted: string;
}
export const CONFIG_VERSION = 3;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
async function json<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function pool<T, R>(items: T[], width: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  let next = 0;
  let failure: unknown;
  const results: R[] = [];
  // Join all workers on failure so no tool invocation survives release of the run lock.
  await Promise.all(Array.from({ length: Math.min(items.length, width) }, async () => {
    while (next < items.length && !failure) {
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return results;
}
const delivered = (run: Evidence) => !run.error && (run.produced.length > 0 || run.answer.trim().length > 0);
const isBase = (run: Evidence) => run.stage.startsWith("baseline");

interface Edited { label: string; files: HarnessFiles; notes: string; keptBase: boolean; fellBack: boolean }
type EditSpec = Pick<ContextSpec, "rollouts" | "pool" | "diffAgainst" | "decisions" | "library">;

export async function runRefinement(options: RunOptions, callAgent: AgentCall): Promise<RunResult> {
  const k = options.k ?? 1, mode = options.mode ?? "parallel", workers = options.workers ?? 2;
  const timeoutMs = options.timeoutMs ?? 600000;
  const leakGlobs = options.leakGlobs ?? [], deliverables = options.deliverables ?? "contents";
  const tolerate = options.tolerateExecutionFailures ?? true;
  if (!options.task.trim()) throw new Error("The task must not be empty");
  if (!Number.isInteger(k) || k < 1 || k > 20) throw new Error("k must be an integer from 1 to 20");
  if (!["parallel", "sequential"].includes(mode)) throw new Error("Invalid recursion mode");
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error("workers must be from 1 to 32");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Invalid session timeout");
  if ((options.instructions?.length ?? 0) > 12000) throw new Error("Initial instructions must be at most 12000 characters");
  if (!Array.isArray(leakGlobs) || !leakGlobs.every(glob => typeof glob === "string" && glob.trim())) throw new Error("leakGlobs must be nonempty strings");
  if (deliverables !== "contents" && deliverables !== "names") throw new Error("deliverables must be contents or names");
  const initial = normalizeHarness(validateHarness(options.harness ?? { "systemprompt.md": options.instructions ?? "" }));
  const bp = benchPrompts(options.guidance);
  options.signal?.throwIfAborted();
  const cwd = await realpath(options.cwd);
  await mkdir(resolve(options.stateDir), { recursive: true });
  const stateDir = await realpath(options.stateDir);
  if (contains(stateDir, cwd)) throw new Error("State directory must not be the workspace or an ancestor of it");
  const domain = options.domain ?? "default";
  const config = { version: CONFIG_VERSION, task: options.task, cwd, stateDir, harness: initial, k, mode,
    domain, model: options.model ?? null, improverModel: options.improverModel ?? options.model ?? null,
    thinkingLevel: options.thinkingLevel ?? "medium", seed: options.seed ?? 0, guidance: options.guidance ?? "",
    tolerateExecutionFailures: tolerate, leakGlobs, deliverables };
  const libraryDir = join(stateDir, "libraries", digest({ ...config, task: undefined, cwd: undefined, stateDir: undefined,
    harness: undefined, guidance: undefined, leakGlobs: undefined, deliverables: undefined }).slice(0, 20));
  const memoryPath = join(libraryDir, "memory.jsonl");
  // Serialize streams sharing a state directory; SQLite itself does not own a process lock.
  const unlock = await processLock(`pi2:${stateDir}`);
  let runDir = "";
  try {
    await mkdir(join(stateDir, "runs"), { recursive: true });
    await mkdir(libraryDir, { recursive: true });
    runDir = options.resume ? await realpath(options.resume) : await mkdtemp(join(stateDir, "runs", "run-"));
    if (!contains(join(stateDir, "runs"), runDir) || runDir === join(stateDir, "runs")) throw new Error("Resume directory must belong to this state directory's runs");
    const stored = await json<{ version?: number }>(join(runDir, "config.json"));
    if (stored && stored.version !== CONFIG_VERSION) throw new Error(`Resume directory was created by an older pi2 (run format ${stored.version ?? 1}); start a new run`);
    if (stored && digest(stored) !== digest(config)) throw new Error("Resume configuration differs from the saved run (task, model, domain, mode, budget, or harness)");
    if (options.resume && !stored) throw new Error("Resume directory has no saved configuration");
    await writeJson(join(runDir, "config.json"), config);
    const completed = await json<RunResult>(join(runDir, "result.json"));
    if (completed && (await json<{ status: string }>(join(runDir, "status.json")))?.status === "completed") return completed;
    let memory = await json<MemoryEntry[]>(join(runDir, "memory-snapshot.json"));
    if (!memory) {
      memory = await readMemory(memoryPath);
      await writeJson(join(runDir, "memory-snapshot.json"), memory);
    }
    const library = memory.length ? { entries: memory, domain } : undefined;
    const progress = async (stage: string) => { await options.onProgress?.(stage, runDir); };
    await progress("snapshot");
    const input = join(runDir, "input");
    if (!await json(join(runDir, "snapshot.json"))) {
      await rm(input, { recursive: true, force: true });
      await rm(join(runDir, "input-pending"), { recursive: true, force: true });
      await copyWorkspace(cwd, join(runDir, "input-pending"), stateDir);
      await rename(join(runDir, "input-pending"), input);
      await writeJson(join(runDir, "snapshot.json"), { ready: true });
    }
    const provided = new Set(await walk(input));

    async function session(label: string, s: {
      tools: boolean; edit?: boolean; files?: HarnessFiles; instructions: string; fingerprint: unknown;
      prepare: (workspace: string) => Promise<string>;
    }): Promise<AgentResponse> {
      options.signal?.throwIfAborted();
      const artifactDir = join(runDir, label), workspace = join(artifactDir, "workspace");
      const fingerprint = digest(s.fingerprint);
      const saved = await json<{ fingerprint: string; response: AgentResponse }>(join(artifactDir, "response.json"));
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw new Error(`${label}: checkpoint input differs`);
        return saved.response;
      }
      await progress(label);
      await mkdir(artifactDir, { recursive: true });
      const ready = await json<{ fingerprint: string }>(join(artifactDir, "request.json"));
      if (ready && ready.fingerprint !== fingerprint) throw new Error(`${label}: pending stage input differs`);
      let prompt: string;
      if (ready) prompt = await readFile(join(artifactDir, "prompt.txt"), "utf8");
      else {
        await rm(workspace, { recursive: true, force: true });
        await mkdir(workspace, { recursive: true });
        prompt = await s.prepare(workspace);
        await writeFile(join(artifactDir, "instructions.md"), s.instructions);
        await writeFile(join(artifactDir, "prompt.txt"), prompt);
        await writeJson(join(artifactDir, "request.json"), { fingerprint });
      }
      const timerController = new AbortController();
      const timer = setTimeout(() => timerController.abort(new Error(`Stage ${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      const signal = AbortSignal.any([timerController.signal, ...(options.signal ? [options.signal] : [])]);
      try {
        await writeJson(join(artifactDir, "status.json"), { status: "running" });
        const response = await callAgent({ stage: label, cwd: workspace, artifactDir, prompt, instructions: s.instructions,
          harness: s.files, tools: s.tools, signal,
          evidenceDir: s.tools ? undefined : join(workspace, "context"),
          editDir: s.edit ? join(workspace, "context", "harness") : undefined });
        signal.throwIfAborted();
        await writeFile(join(artifactDir, "answer.txt"), response.text);
        await writeFile(join(artifactDir, "trace.txt"), response.trace);
        await writeJson(join(artifactDir, "response.json"), { fingerprint, response });
        await writeJson(join(artifactDir, "status.json"), { status: "completed" });
        return response;
      } catch (error) {
        await writeJson(join(artifactDir, "status.json"), { status: "failed", error: String(error) });
        throw new Error(`${label}: ${message(error)}`, { cause: error });
      } finally { clearTimeout(timer); }
    }

    /** One rollout. A failed rollout is evidence, recorded once and replayed on resume. */
    async function execute(label: string, files: HarnessFiles): Promise<Evidence> {
      const fingerprint = { kind: "execute", task: options.task, files };
      const workspace = join(runDir, label, "workspace"), failurePath = join(runDir, label, "failure.json");
      const failed = await json<{ fingerprint: string; error: string }>(failurePath);
      if (failed?.fingerprint === digest(fingerprint)) {
        return { stage: label, files, answer: "", trace: "", produced: await producedFiles(input, workspace), error: failed.error };
      }
      try {
        const response = await session(label, { tools: true, files, fingerprint,
          instructions: [SOLVER_SYSTEM, harnessInstructions(files)].filter(Boolean).join("\n\n"),
          prepare: async dir => {
            await copyWorkspace(input, dir);
            await rm(join(dir, HARNESS_ROOT), { recursive: true, force: true });
            await writeHarness(join(dir, HARNESS_ROOT), files);
            return options.task;
          } });
        return { stage: label, files, answer: response.text, trace: response.trace, produced: await producedFiles(input, workspace) };
      } catch (error) {
        if (!tolerate || options.signal?.aborted) throw error;
        await writeJson(failurePath, { fingerprint: digest(fingerprint), error: message(error) });
        return { stage: label, files, answer: "", trace: "", produced: await producedFiles(input, workspace), error: message(error) };
      }
    }

    /** One editing stage: the editor changes context/harness/ in place; an invalid tree gets one corrective attempt. */
    async function edit(label: string, job: string, start: HarnessFiles, spec: EditSpec): Promise<Edited> {
      let error = "", seed = start;
      for (let attempt = 0; attempt < 2; attempt++) {
        const stage = attempt ? `${label}-retry` : label;
        const retry = error ? `\n\n# YOUR PREVIOUS PROPOSAL WAS REJECTED\n\nValidation said: ${error}\n\nThe rejected tree is in \`context/harness/\` as you left it. Fix exactly what validation names. This is the last attempt: if it fails again, the stage keeps the harness it started from.` : "";
        const tree = seed;
        const response = await session(stage, { tools: false, edit: true, instructions: EDITOR_SYSTEM,
          fingerprint: { kind: "edit", job, retry, tree, spec },
          prepare: async workspace => mission(job + retry, await buildContext({
            ...spec, root: workspace, runDir, task: options.task, leakGlobs, deliverables, harness: tree,
          })) });
        const treePath = join(runDir, stage, "harness.json");
        let read = await json<{ files: HarnessFiles; rejected: string[] }>(treePath);
        if (!read) {
          read = await readTree(join(runDir, stage, "workspace", "context", "harness"));
          await writeJson(treePath, read);
        }
        error = "";
        if (read.rejected.length) error = `these files are off the editable surface and were not applied: ${read.rejected.slice(0, 6).join(", ")}. Component names must be lowercase letters, digits, \`_\` or \`-\` (e.g. \`skills/doc_review/SKILL.md\`, \`scripts/check_totals.py\`).`;
        else if (!Object.keys(read.files).length && Object.keys(tree).length) error = "`context/harness/` came back empty -- edit the files, do not delete them all";
        else {
          try { await checkHarness(read.files, { provided, signal: options.signal }); }
          catch (failure) { options.signal?.throwIfAborted(); error = message(failure); }
        }
        if (!error) return { label, files: read.files, notes: parseNotes(response.text), keptBase: sameHarness(read.files, start), fellBack: false };
        seed = read.files;
      }
      await writeJson(join(runDir, `${label}-fallback.json`), { error, retained: start });
      return { label, files: start, notes: `Proposal rejected twice; kept the starting harness. Last validation error: ${error}`, keptBase: true, fellBack: true };
    }

    const indexes = Array.from({ length: k }, (_, i) => i + 1);
    const label = (name: string, i: number) => k === 1 ? name : `${name}-${i}`;
    const dims: Dimension[] = ["INV", "DOM"];
    const decisions: Record<string, string> = {};
    const record = (edited: Edited[]) => { for (const e of edited) decisions[e.label] = e.keptBase && !e.fellBack ? `KEEP_BASE\n\n${e.notes}` : e.notes; };
    const baselines = await pool(indexes, workers, i => execute(label("baseline", i), initial));
    if (!baselines.some(delivered)) throw new Error(`No baseline execution delivered anything:\n${baselines.map(b => b.error ?? `${b.stage}: produced nothing`).join("\n")}`);
    const runs: Evidence[] = [...baselines];
    const finals: Evidence[] = [];
    if (mode === "parallel") {
      const slots = indexes.flatMap(i => dims.map(dim => ({ i, dim })));
      const edited = await pool(slots, workers, s => edit(label(`propose-${s.dim.toLowerCase()}`, s.i),
        propose(bp, s.dim, { k, index: s.i }), initial, { rollouts: baselines, library }));
      record(edited);
      const probes = await pool(slots, workers, (s, n) => execute(label(`probe-${s.dim.toLowerCase()}`, s.i), edited[n].files));
      runs.push(...probes);
      const composed = await pool(indexes, workers, i => edit(label("compose", i), aggregate(bp, { k }), initial,
        { rollouts: baselines, pool: probes, diffAgainst: initial, decisions: { ...decisions }, library }));
      record(composed);
      finals.push(...await pool(indexes, workers, (i, n) => execute(label("composed", i), composed[n].files)));
      runs.push(...finals);
    } else {
      let current = initial;
      for (const t of indexes) {
        const earlier = runs.filter(run => !isBase(run));
        const edited = await pool(dims, workers, dim => edit(label(`propose-${dim.toLowerCase()}`, t),
          propose(bp, dim, { roundT: t }), current,
          { rollouts: baselines, pool: earlier.length ? earlier : undefined, diffAgainst: current, decisions: { ...decisions }, library }));
        record(edited);
        runs.push(...await pool(dims, workers, (dim, n) => execute(label(`probe-${dim.toLowerCase()}`, t), edited[n].files)));
        const checkpoint = await edit(label("compose", t), composeRound(bp, t, k), current,
          { rollouts: baselines, pool: runs.filter(run => !isBase(run)), diffAgainst: current, decisions: { ...decisions }, library });
        record([checkpoint]);
        const final = await execute(label("composed", t), checkpoint.files);
        runs.push(final); finals.push(final);
        current = checkpoint.files;
      }
    }

    // The pool is finals only; base rollouts deliver only when no final delivered anything.
    let viable = finals.filter(delivered), poolKind = "finals";
    if (!viable.length) { viable = baselines.filter(delivered); poolKind = "baselines (no final delivered)"; }
    let chosen = viable[0], why = "", selectionError = "";
    let idMap: Record<string, string> = {};
    if (viable.length > 1) {
      const ordered = seededOrder(viable, `${options.task}|${k}|${mode}|${options.seed ?? 0}`, run => run.stage);
      const ids = ordered.map((_, i) => String.fromCharCode(65 + i));
      idMap = Object.fromEntries(ids.map((id, i) => [id, ordered[i].stage]));
      for (let attempt = 0; attempt < 2; attempt++) {
        const retry = selectionError ? `\n\n# YOUR PREVIOUS REPLY WAS INVALID\n\n${selectionError}. End with a \`\`\`choice block naming exactly one of the ids.` : "";
        const response = await session(attempt ? "select-retry" : "select", { tools: false, instructions: READER_SYSTEM,
          fingerprint: { kind: "select", idMap, retry, candidates: ordered.map(run => ({ stage: run.stage, answer: run.answer, produced: run.produced })) },
          prepare: async workspace => selectMission(select(bp, ids.length) + retry, await buildContext({
            root: workspace, runDir, task: options.task, leakGlobs, deliverables, candidates: ordered.map((run, i) => ({ id: ids[i], run })),
          }), ids) });
        try {
          const choice = parseChoice(response.text, ids);
          chosen = ordered[ids.indexOf(choice.id)]; why = choice.why; selectionError = "";
          break;
        } catch (failure) { selectionError = message(failure); }
      }
      if (selectionError) {
        chosen = viable[0];
        await writeJson(join(runDir, "select-fallback.json"), { error: selectionError, adopted: chosen.stage });
      }
    }
    if (!chosen) throw new Error(`No execution delivered anything:\n${runs.map(r => r.error ?? `${r.stage}: produced nothing`).join("\n")}`);
    await writeJson(join(runDir, "selection.json"), {
      pool: viable.map(run => run.stage), poolKind, dropped: finals.filter(run => !delivered(run)).map(run => run.stage),
      idMap, chosen: chosen.stage, why, trivial: viable.length === 1, fallback: selectionError || null,
    });

    let lesson: Experience | null = null, edits = "", reflectionError = "";
    const adoption = { chosen_label: chosen.stage, candidate_ids: idMap, reason: why };
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = reflectionError ? `\n\n# YOUR PREVIOUS REPLY WAS INVALID\n\n${reflectionError}. Reply with the <edits> block and then either one <experience> block or the single line NO_ENTRY.` : "";
      const job = `${experience(bp)}\n# WHAT HAPPENED\n\nHarness ${chosen.stage} was adopted. The selection reasoning was:\n\n${why || "(a single delivered final; no selector session ran)"}\n\ncontext/adoption.json maps any anonymous IDs in that reasoning to rollout labels. Compare context/harness/ with context/base_harness/ and the candidates in context/pool/. Read the decisions and execution contrasts before writing.${retry}`;
      const reflectPool = runs.filter(run => !isBase(run));
      const response = await session(attempt ? "reflect-retry" : "reflect", { tools: false, instructions: READER_SYSTEM,
        fingerprint: { kind: "reflect", job, adoption, decisions, runs: runs.map(run => ({ stage: run.stage, answer: run.answer, error: run.error ?? null, produced: run.produced, files: run.files })) },
        prepare: async workspace => mission(job, await buildContext({
          root: workspace, runDir, task: options.task, leakGlobs, deliverables,
          harness: chosen.files, harnessNote: `the adopted harness, from ${chosen.stage}`, baseHarness: initial,
          rollouts: baselines, pool: reflectPool.length ? reflectPool : undefined, diffAgainst: initial, decisions, adoption,
        })) });
      try {
        ({ edits, experience: lesson } = parseReflection(response.text));
        const marker = GRADER_MARKERS.find(m => JSON.stringify(lesson ?? {}).includes(m) || why.includes(m));
        if (marker) throw new Error(`the experience repeats a grader verdict (${marker}); describe execution behavior instead`);
        reflectionError = "";
        break;
      } catch (failure) { lesson = null; reflectionError = message(failure); }
    }
    if (reflectionError) await writeJson(join(runDir, "reflect-fallback.json"), { error: reflectionError, lesson: null });
    if (edits) await writeFile(join(runDir, "edits.md"), `${edits}\n`);
    options.signal?.throwIfAborted();
    const result: RunResult = { runDir, outputDir: join(runDir, chosen.stage, "workspace"), answer: chosen.answer,
      instructions: chosen.files["systemprompt.md"] ?? "", harness: chosen.files, learned: lesson !== null, libraryDir, adopted: chosen.stage };
    if (lesson) {
      const runId = basename(runDir);
      if (!(await readMemory(memoryPath)).some(entry => entry.runId === runId)) {
        await appendMemory(memoryPath, { runId, task: options.task, adopted: chosen.stage, why, ...lesson, edits, files: chosen.files });
      }
      await renderLibrary(libraryDir, await readMemory(memoryPath), domain);
    }
    await writeJson(join(runDir, "result.json"), result);
    await writeJson(join(runDir, "status.json"), { status: "completed", adopted: chosen.stage, learned: result.learned });
    return result;
  } catch (error) {
    if (runDir && !/Resume configuration|Resume directory/.test(String(error))) await writeJson(join(runDir, "status.json"), { status: "failed", error: String(error) });
    throw new Error(`${message(error)}${runDir ? `\nRun artifacts: ${runDir}` : ""}`, { cause: error });
  } finally { await unlock(); }
}
