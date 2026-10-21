import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  compositionPrompt, context, EDITOR_SYSTEM, parseLesson, parseProposal, proposalPrompt, reflectionPrompt,
  type Evidence, type Proposal,
} from "./prompts.js";
import { appendMemory, contains, copyWorkspace, readMemory, writeJson } from "./storage.js";

export interface AgentRequest {
  stage: string;
  cwd: string;
  artifactDir: string;
  prompt: string;
  instructions: string;
  tools: boolean;
  signal: AbortSignal;
}

export interface AgentResponse {
  text: string;
  trace: string;
}

/** Implementations must honor signal and clean up their sessions on completion or cancellation. */
export type AgentCall = (request: AgentRequest) => Promise<AgentResponse>;

export interface RunOptions {
  task: string;
  cwd: string;
  stateDir: string;
  instructions?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
  onProgress?: (stage: string, runDir: string) => void;
}

export interface RunResult {
  runDir: string;
  outputDir: string;
  answer: string;
  instructions: string;
  learned: boolean;
}

export async function runRefinement(options: RunOptions, callAgent: AgentCall): Promise<RunResult> {
  const instructions = options.instructions ?? "";
  const timeoutMs = options.timeoutMs ?? 600000;
  if (!options.task.trim()) throw new Error("The task must not be empty");
  if (instructions.length > 12000) throw new Error("Initial instructions must be at most 12000 characters");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Invalid session timeout");
  options.signal?.throwIfAborted();
  const cwd = await realpath(options.cwd);
  await mkdir(resolve(options.stateDir), { recursive: true });
  const stateDir = await realpath(options.stateDir);
  if (contains(stateDir, cwd)) throw new Error("State directory must not be the workspace or an ancestor of it");
  const memoryPath = join(stateDir, "memory.jsonl");
  const memory = await readMemory(memoryPath);
  await mkdir(join(stateDir, "runs"), { recursive: true });
  const runDir = await mkdtemp(join(stateDir, "runs", "run-"));
  const statusPath = join(runDir, "status.json");
  let stage = "snapshot";
  const runs: Evidence[] = [];

  async function agent(label: string, prompt: string, harness: string, tools: boolean): Promise<AgentResponse> {
    stage = label;
    options.signal?.throwIfAborted();
    const artifactDir = join(runDir, label);
    const workspace = join(artifactDir, "workspace");
    await mkdir(workspace, { recursive: true });
    if (tools) await copyWorkspace(join(runDir, "input"), workspace);
    await writeFile(join(artifactDir, "instructions.md"), harness);
    await writeFile(join(artifactDir, "prompt.txt"), prompt);
    await writeJson(statusPath, { status: "running", stage });
    options.onProgress?.(stage, runDir);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error(`Stage ${stage} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    const signal = AbortSignal.any([timeout.signal, ...(options.signal ? [options.signal] : [])]);
    let onAbort: () => void = () => {};
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const response = await Promise.race([
        callAgent({ stage, cwd: workspace, artifactDir, prompt, instructions: harness, tools, signal }),
        cancelled,
      ]);
      signal.throwIfAborted();
      await writeFile(join(artifactDir, "answer.txt"), response.text);
      await writeFile(join(artifactDir, "trace.txt"), response.trace);
      return response;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function execute(label: string, proposal: Proposal): Promise<Evidence> {
    const response = await agent(label, options.task, proposal.instructions, true);
    const evidence = { stage: label, ...proposal, answer: response.text, trace: response.trace };
    runs.push(evidence);
    return evidence;
  }

  try {
    await writeJson(join(runDir, "config.json"), { task: options.task, cwd, model: options.model, timeoutMs, instructions });
    await writeJson(statusPath, { status: "running", stage });
    options.onProgress?.(stage, runDir);
    await copyWorkspace(cwd, join(runDir, "input"), stateDir);
    options.signal?.throwIfAborted();
    await execute("baseline", { instructions, rationale: "Initial harness" });
    const baselineContext = context(options.task, runs, memory);
    const general = parseProposal((await agent("propose-general", proposalPrompt("general", baselineContext), EDITOR_SYSTEM, false)).text);
    const specific = parseProposal((await agent("propose-task", proposalPrompt("task-specific", baselineContext), EDITOR_SYSTEM, false)).text);
    await execute("probe-general", general);
    await execute("probe-task", specific);
    const composed = parseProposal((await agent("compose", compositionPrompt(context(options.task, runs, memory)), EDITOR_SYSTEM, false)).text);
    const final = await execute("composed", composed);
    const lesson = parseLesson((await agent("reflect", reflectionPrompt(context(options.task, runs, memory)), EDITOR_SYSTEM, false)).text);
    options.signal?.throwIfAborted();
    const result: RunResult = {
      runDir, outputDir: join(runDir, "composed", "workspace"), answer: final.answer,
      instructions: composed.instructions, learned: lesson !== null,
    };
    await writeJson(join(runDir, "result.json"), result);
    if (lesson) await appendMemory(memoryPath, { runId: basename(runDir), instructions: composed.instructions, ...lesson });
    await writeJson(statusPath, { status: "completed", stage: "reflect", learned: result.learned });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJson(statusPath, { status: "failed", stage, error: message });
    throw new Error(`${stage}: ${message}\nRun artifacts: ${runDir}`, { cause: error });
  }
}
