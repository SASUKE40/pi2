#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runRefinement } from "./core.js";

const HELP = `Usage: pi2 "task" [options]

One Harness2 refinement step using Pi: baseline, two probes, composition, reflection.

  --cwd DIR          Input workspace (default: current directory)
  --model P/M        Pi provider/model (default: Pi's configured model)
  --harness FILE     Initial Markdown instructions (default: empty)
  --state-dir DIR   Run artifacts and lessons (default: ~/.pi2/<workspace hash>)
  --timeout SEC     Timeout per agent session (default: 600)
  --help            Show this help

Every execution uses a fresh workspace copy. Results are never applied back automatically.
Eight agent sessions normally run; API calls inside each session may vary.
`;

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" }, model: { type: "string" }, harness: { type: "string" },
      "state-dir": { type: "string" }, timeout: { type: "string" }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
  } else {
    if (positionals.length !== 1 || !positionals[0].trim()) throw new Error(`Provide exactly one nonempty task.\n\n${HELP}`);
    const timeout = Number(values.timeout ?? "600");
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647) throw new Error("--timeout must be positive and at most 2147483 seconds");
    const cwd = await realpath(values.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error("--cwd must be a directory");
    const stateDir = values["state-dir"] ? resolve(values["state-dir"]) : join(homedir(), ".pi2", createHash("sha256").update(cwd).digest("hex").slice(0, 16));
    const instructions = values.harness ? await readFile(values.harness, "utf8") : "";
    if (instructions.length > 12000) throw new Error("Initial instructions must be at most 12000 characters");
    // Keep --help and argument validation independent of SDK initialization and authentication.
    const { createPiAgent } = await import("./pi.js");
    const agent = await createPiAgent({ cwd, model: values.model, signal: controller.signal });
    process.stderr.write(`Model: ${agent.model}\n`);
    const result = await runRefinement({
      task: positionals[0], cwd, stateDir, instructions, model: agent.model,
      timeoutMs: timeout * 1000, signal: controller.signal,
      onProgress: (stage, runDir) => process.stderr.write(`${stage}${stage === "snapshot" ? `: ${runDir}` : ""}\n`),
    }, agent.call);
    process.stdout.write(`${result.answer}\n\nOutput: ${result.outputDir}\nRun: ${result.runDir}\nLesson saved: ${result.learned ? "yes" : "no"}\n`);
  }
} catch (error) {
  process.stderr.write(`pi2: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
