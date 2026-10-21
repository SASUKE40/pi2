import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { diffHarness, GRADER_MARKERS, HARNESS_ROOT, writeHarness, type HarnessFiles } from "./harness.js";
import { renderLibrary } from "./library.js";
import { copyWorkspace, writeJson, type MemoryEntry } from "./storage.js";

/** One execution: the harness it ran, what it answered, its transcript and the files it produced. */
export interface Evidence {
  stage: string; files: HarnessFiles; answer: string; trace: string; produced: string[]; error?: string;
}
export type DeliverableMode = "contents" | "names";
const OBSERVATION_LIMIT = 50000;
const COPY_LIMIT = 20_000_000;
const TEXT_SUFFIX = /\.(?:md|txt|json|csv|tsv|ya?ml|html?|log|py|js|mjs|sh|xml|ini|toml|patch|diff)$|^[^.]*$/i;

function clip(text: string, limit = OBSERVATION_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[renderer truncated ${text.length - limit} chars of this observation; the solver saw them]`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : "").filter(Boolean).join("\n");
}

/** Render a Pi Durable transcript (trace entries or raw messages) as a readable trajectory. */
export function renderTrajectory(trace: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(trace); } catch { return trace.trim() || "(no trajectory recorded)"; }
  if (!Array.isArray(parsed)) return trace;
  const messages = parsed.flatMap((item: any) => Array.isArray(item?.model) ? item.model : item?.role ? [item] : []);
  const out: string[] = [];
  let step = 0, calls = 0, errors = 0;
  for (const message of messages) {
    if (message.role === "user") out.push(`### User\n${clip(contentText(message.content))}`);
    else if (message.role === "assistant") {
      step++;
      const parts: string[] = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === "thinking" && block.thinking?.trim()) parts.push(`(thinking) ${clip(block.thinking, 8000)}`);
        else if (block.type === "text" && block.text?.trim()) parts.push(block.text);
        else if (block.type === "toolCall") { calls++; parts.push(`→ \`${block.name}\` ${clip(JSON.stringify(block.arguments ?? {}), 8000)}`); }
      }
      out.push(`### Step ${step} (assistant)\n${parts.join("\n") || "(empty turn)"}`);
    } else if (message.role === "toolResult") {
      if (message.isError) errors++;
      out.push(`← \`${message.toolName}\`${message.isError ? " ERROR" : ""}\n${clip(contentText(message.content))}`);
    }
  }
  return [`${step} model turns, ${calls} tool calls, ${errors} tool errors.`, "", ...out].join("\n\n");
}

export async function walk(root: string, skip: (rel: string) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, item.name), rel = relative(root, path).split("\\").join("/");
      if (skip(rel)) continue;
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) out.push(rel);
    }
  }
  await visit(root);
  return out.sort();
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([stat(a), stat(b)]);
    if (x.size !== y.size) return false;
    return (await readFile(a)).equals(await readFile(b));
  } catch { return false; }
}

/** Files an execution created or changed relative to the input snapshot. */
export async function producedFiles(input: string, workspace: string): Promise<string[]> {
  const files = await walk(workspace, rel => rel === HARNESS_ROOT || rel.startsWith(`${HARNESS_ROOT}/`));
  const changed = await Promise.all(files.map(async rel => (await sameFile(join(input, rel), join(workspace, rel))) ? null : rel));
  return changed.filter((rel): rel is string => rel !== null);
}

function globRegex(pattern: string): RegExp {
  const body = pattern.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^(?:.*/)?${body}$`);
}

/** Leak globs apply everywhere; grader markers are searched only outside the task's own source. */
export async function assertClean(root: string, leakGlobs: string[]): Promise<void> {
  const patterns = leakGlobs.map(globRegex);
  for (const rel of await walk(root)) {
    if (patterns.some(p => p.test(rel))) throw new Error(`Answer-key path would enter model context: ${rel}`);
    if (rel.startsWith("source/")) continue;
    const marker = GRADER_MARKERS.find(m => rel.includes(m));
    if (marker) throw new Error(`Grader verdict would enter model context: ${rel} matches ${marker}`);
    const name = rel.split("/").at(-1)!;
    if (!TEXT_SUFFIX.test(name) || (await stat(join(root, rel))).size > COPY_LIMIT) continue;
    const body = await readFile(join(root, rel), "utf8");
    const found = GRADER_MARKERS.find(m => body.includes(m));
    if (found) throw new Error(`Grader verdict would enter model context: ${rel} contains ${found}`);
  }
}

async function copyFiles(from: string, to: string, files: string[]): Promise<string[]> {
  const omitted: string[] = [];
  for (const rel of files) {
    const info = await lstat(join(from, rel)).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > COPY_LIMIT) { omitted.push(`${rel} (${info.size} bytes)`); continue; }
    await mkdir(dirname(join(to, rel)), { recursive: true });
    await copyFile(join(from, rel), join(to, rel));
  }
  return omitted;
}

const WITHHELD = "File contents are deliberately withheld on this benchmark: reason from the trajectory and from the file set itself. A missing or misnamed file is a finding; do not infer that an unlisted file is empty.";

async function writeProduced(dir: string, runDir: string, run: Evidence, mode: DeliverableMode): Promise<void> {
  await mkdir(dir, { recursive: true });
  const omitted = mode === "contents" ? await copyFiles(join(runDir, run.stage, "workspace"), dir, run.produced) : [];
  await writeFile(join(dir, "INDEX.md"), [
    `# ${run.stage} produced ${run.produced.length} file(s)`, "",
    ...run.produced.map(p => `- \`${p}\``), "",
    run.produced.length ? "" : run.answer.trim() ? "No files were created or changed; the final answer in the rollout is its only output." : "This rollout PRODUCED NOTHING.",
    ...(omitted.length ? [`Too large to copy: ${omitted.join(", ")}`] : []),
    mode === "names" ? WITHHELD : "Each file is the artifact as the run left it, at its workspace-relative path.",
  ].join("\n"));
}

async function trajectory(runDir: string, run: Evidence): Promise<string> {
  let trace = run.trace;
  if (!trace.trim() || trace.startsWith("Execution failed")) trace = await readFile(join(runDir, run.stage, "messages.json"), "utf8").catch(() => trace);
  return [
    `# ${run.stage}`, "",
    run.error ? `Status: FAILED — ${run.error}` : "Status: completed",
    run.produced.length ? `Produced ${run.produced.length} file(s): ${run.produced.slice(0, 40).map(p => `\`${p}\``).join(", ")}${run.produced.length > 40 ? ", …" : ""}`
      : run.answer.trim() ? "Produced no files." : "PRODUCED NOTHING.",
    "", "## Final answer", run.answer.trim() || "(none)", "", "## Trajectory", renderTrajectory(trace),
  ].join("\n");
}

export interface ContextSpec {
  root: string; runDir: string; task: string; leakGlobs: string[]; deliverables: DeliverableMode;
  harness?: HarnessFiles; harnessNote?: string; baseHarness?: HarnessFiles; rollouts?: Evidence[]; pool?: Evidence[];
  diffAgainst?: HarnessFiles; decisions?: Record<string, string>; library?: { entries: MemoryEntry[]; domain: string };
  candidates?: { id: string; run: Evidence }[]; adoption?: unknown;
}

/** Build `context/` under `root` and return the layout lines that describe only what exists. */
export async function buildContext(spec: ContextSpec): Promise<string[]> {
  const context = join(spec.root, "context");
  await rm(context, { recursive: true, force: true });
  await mkdir(context, { recursive: true });
  const layout = ["context/task.md                  the task as the agent received it"];
  await writeFile(join(context, "task.md"), spec.task);
  await copyWorkspace(join(spec.runDir, "input"), join(context, "source"));
  const leaks = spec.leakGlobs.map(globRegex);
  for (const rel of await walk(join(context, "source"))) if (leaks.some(p => p.test(rel))) await rm(join(context, "source", rel));
  layout.push("context/source/                  the workspace the task started from");
  if (spec.decisions && Object.keys(spec.decisions).length) {
    for (const [label, notes] of Object.entries(spec.decisions)) {
      await mkdir(join(context, "decisions"), { recursive: true });
      await writeFile(join(context, "decisions", `${label}.md`), notes.trim() || "No decision notes returned.");
    }
    layout.push("context/decisions/               earlier edits and composition decisions, one file per stage");
  }
  if (spec.rollouts?.length) {
    for (const run of spec.rollouts) {
      await mkdir(join(context, "rollouts"), { recursive: true });
      await writeFile(join(context, "rollouts", `${run.stage}.md`), await trajectory(spec.runDir, run));
      await writeProduced(join(context, "deliverables", run.stage), spec.runDir, run, spec.deliverables);
    }
    layout.push(`context/rollouts/                FULL trajectories: ${spec.rollouts.map(r => `${r.stage}.md`).join(", ")}`);
    layout.push(spec.deliverables === "names"
      ? "context/deliverables/<label>/    INDEX.md lists WHICH files each rollout produced -- names only"
      : "context/deliverables/<label>/    the files each rollout produced (INDEX.md lists the set)");
  }
  if (spec.harness) {
    await writeHarness(join(context, "harness"), spec.harness, { placeholders: true });
    layout.push(`context/harness/                 ${spec.harnessNote ?? "the harness you are editing"} (${Object.keys(spec.harness).length} files)`);
  }
  if (spec.baseHarness) {
    await writeHarness(join(context, "base_harness"), spec.baseHarness, { placeholders: true });
    layout.push("context/base_harness/            the unmodified harness every candidate was edited from");
  }
  if (spec.pool?.length) {
    for (const run of spec.pool) {
      const dir = join(context, "pool", run.stage);
      await writeHarness(join(dir, "harness"), run.files, { placeholders: true });
      await writeFile(join(dir, "harness.diff"), diffHarness(spec.diffAgainst ?? spec.harness ?? {}, run.files, ["current", run.stage]));
      await writeFile(join(dir, "rollout.md"), await trajectory(spec.runDir, run));
      await writeProduced(join(dir, "produced"), spec.runDir, run, spec.deliverables);
    }
    layout.push(`context/pool/<label>/            ${spec.pool.length} candidates (${spec.pool.map(r => r.stage).join(", ")}): harness/, harness.diff, rollout.md, produced/`);
  }
  if (spec.library?.entries.length) {
    await renderLibrary(join(context, "library"), spec.library.entries, spec.library.domain);
    layout.push("context/library/                 earlier tasks in this area -- browse INDEX.md first, then open what looks relevant");
  }
  if (spec.candidates?.length) {
    await mkdir(join(context, "candidates"), { recursive: true });
    for (const { id, run } of spec.candidates) {
      const omitted = await copyFiles(join(spec.runDir, run.stage, "workspace"), join(context, "candidates", id), run.produced);
      await writeFile(join(context, "candidates", `${id}.md`), [
        `<!-- candidate ${id}: COMPLETE -- nothing trimmed. -->`, `# Candidate ${id}`, "",
        run.produced.length ? `Files it produced (under context/candidates/${id}/): ${run.produced.map(p => `\`${p}\``).join(", ")}` : "It produced no files.",
        ...(omitted.length ? [`Too large to copy: ${omitted.join(", ")}`] : []),
        "", "## Final answer", run.answer.trim() || "(none)",
      ].join("\n"));
    }
    layout.push(`context/candidates/<id>.md       one per candidate (${spec.candidates.map(c => c.id).join(", ")}): its final answer and the files it produced`);
    layout.push("context/candidates/<id>/         the produced files themselves, at their workspace-relative paths");
  }
  if (spec.adoption !== undefined) {
    await writeJson(join(context, "adoption.json"), spec.adoption);
    layout.push("context/adoption.json            which output was adopted, and the selector's reasoning");
  }
  await assertClean(context, spec.leakGlobs);
  return layout;
}
