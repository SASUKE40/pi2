#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { runRefinement } from "./core.js";
import { readHarness } from "./harness.js";

const HELP = `Usage: pi2 "task" [options]
       pi2 --resume RUN_DIR
       pi2 bench <setup|check|tasks|split|run|judge|report> --help

Harness2 refinement with Pi Durable, pi-ai, and Chord.

  --cwd DIR           Input workspace (default: current directory)
  --model P/M         Solver provider/model (or PI2_MODEL, then first available)
  --improver-model P/M  Separate model for proposal, composition, selection, reflection
  --thinking LEVEL    off, minimal, low, medium (default), high, xhigh
  --harness PATH      Initial Markdown file or harness directory
  --k N               Recursion budget, 1–20 (default: 1)
  --mode MODE         parallel (default) or sequential
  --workers N         Concurrent independent stages, 1–32 (default: 2)
  --domain NAME       Learning domain (default: default)
  --state-dir DIR     Run artifacts and lessons (default: ~/.pi2/<workspace hash>)
  --resume RUN_DIR    Continue a saved run using its configuration and snapshot
  --timeout SEC       Timeout per agent session (default: 600)
  --help              Show this help

Every execution uses a fresh workspace copy. Results are never applied back automatically.
At k=1 there are eight agent sessions before any corrective retries. Provider charges apply.
`;
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  if (process.argv[2] === "bench") {
    const { benchCli } = await import("./bench-cli.js");
    await benchCli(process.argv.slice(3), controller.signal);
  } else {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    cwd: { type: "string" }, model: { type: "string" }, "improver-model": { type: "string" }, thinking: { type: "string" },
    harness: { type: "string" }, "state-dir": { type: "string" }, timeout: { type: "string" }, help: { type: "boolean" },
    k: { type: "string" }, mode: { type: "string" }, workers: { type: "string" }, domain: { type: "string" }, resume: { type: "string" },
  } });
  if (values.help) process.stdout.write(HELP);
  else {
    const saved = values.resume ? JSON.parse(await readFile(join(resolve(values.resume), "config.json"), "utf8")) : undefined;
    if (positionals.length > 1 || (!saved && (positionals.length !== 1 || !positionals[0].trim()))) throw new Error(`Provide exactly one nonempty task.\n\n${HELP}`);
    const task = positionals[0] ?? saved?.task;
    const timeout = Number(values.timeout ?? "600");
    const k = Number(values.k ?? saved?.k ?? 1), workers = Number(values.workers ?? 2);
    const mode = values.mode ?? saved?.mode ?? "parallel";
    const thinking = values.thinking ?? saved?.thinkingLevel ?? "medium";
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647) throw new Error("--timeout must be positive and at most 2147483 seconds");
    if (!Number.isInteger(k) || k < 1 || k > 20) throw new Error("--k must be from 1 to 20");
    if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error("--workers must be from 1 to 32");
    if (!["parallel", "sequential"].includes(mode)) throw new Error("--mode must be parallel or sequential");
    if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinking)) throw new Error("Invalid --thinking level");
    const cwd = await realpath(values.cwd ?? saved?.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error("--cwd must be a directory");
    const stateDir = values["state-dir"] ? resolve(values["state-dir"]) : saved?.stateDir ?? join(homedir(), ".pi2", createHash("sha256").update(cwd).digest("hex").slice(0, 16));
    const harness = values.harness ? await readHarness(values.harness) : saved?.harness;
    const { createPiAgent } = await import("./pi.js");
    const agent = await createPiAgent({ cwd, model: values.model ?? saved?.model,
      improverModel: values["improver-model"] ?? saved?.improverModel, thinkingLevel: thinking as ModelThinkingLevel, signal: controller.signal });
    process.stderr.write(`Model: ${agent.model}\nImprover: ${agent.improverModel}\n`);
    const result = await runRefinement({ task, cwd, stateDir, harness, model: agent.model, improverModel: agent.improverModel,
      thinkingLevel: agent.thinkingLevel, k, mode, workers, domain: values.domain ?? saved?.domain, resume: values.resume,
      timeoutMs: timeout * 1000, signal: controller.signal,
      onProgress: (stage, runDir) => { process.stderr.write(`${stage}${stage === "snapshot" ? `: ${runDir}` : ""}\n`); },
    }, agent.call);
    process.stdout.write(`${result.answer}\n\nOutput: ${result.outputDir}\nRun: ${result.runDir}\nLesson saved: ${result.learned ? "yes" : "no"}\n`);
  }
  }
} catch (error) {
  process.stderr.write(`pi2: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
