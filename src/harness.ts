import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { runProcess } from "./process.js";

export type HarnessFiles = Record<string, string>;
/** The four files injected into every solver call (C1–C4 of the paper's Table 5). */
export const ALWAYS_ON = ["systemprompt.md", "guardrails.md", "LongTermMEMORY.md", "tool_descriptions/tool_guidance.md"] as const;
/** Where the tree is mounted inside every execution workspace. */
export const HARNESS_ROOT = ".pi2-harness";
export const ALWAYS_ON_MAX = 24000;
const NAME = "[a-z0-9][a-z0-9_-]*";
const SKILL = new RegExp(`^skills/(${NAME})/SKILL\\.md$`);
const SKILL_SCRIPT = new RegExp(`^skills/${NAME}/scripts/[A-Za-z0-9_.-]+$`);
const SUBAGENT = new RegExp(`^sub_agents/(${NAME})/AGENT\\.md$`);
const SCRIPT = /^scripts\/[a-z0-9_][a-z0-9_]*\.mjs$/;
const PLUGIN = new RegExp(`^plugin/(${NAME})\\.mjs$`);
const SCRIPT_REF = /node\s+((?:\.\/)?(?:\.pi2-harness\/)?(?:skills\/[\w-]+\/)?scripts\/[\w.-]+\.mjs)/g;
/** Where autotrigger appends a missing skill trigger line. */
const TRIGGER_FILE = "guardrails.md";
const triggerLine = (name: string, desc: string) => `- When ${desc}, read \`${HARNESS_ROOT}/skills/${name}/SKILL.md\` and follow it.\n`;
/** Strings that only a grader's output contains; a tree carrying one could never be served as evidence. */
export const GRADER_MARKERS = [
  "deterministic_eval_summary", "deterministic_eval_result", "judge_scope_and_deterministic_status",
  "Judge findings on the rendered result", '"passed_count"', '"pass_rate"', '"test_pass_rate"',
];

export function isAllowed(path: string): boolean {
  if (path.split("/").some(part => part === ".." || part === "." || part === "")) return false;
  return (ALWAYS_ON as readonly string[]).includes(path)
    || [SKILL, SKILL_SCRIPT, SUBAGENT, SCRIPT, PLUGIN].some(pattern => pattern.test(path));
}

/** Structural validation: allowed paths, string bodies and size limits. */
export function validateHarness(value: unknown): HarnessFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected harness files object");
  const files: HarnessFiles = {};
  let size = 0;
  for (const [path, body] of Object.entries(value)) {
    if (!isAllowed(path) || typeof body !== "string" || body.length > 64000) throw new Error(`Invalid harness file: ${path}`);
    size += body.length;
    if (size > 256000) throw new Error("Harness exceeds 256000 characters");
    files[path] = body;
  }
  return files;
}

/** Empty always-on files are equivalent to absent ones. */
export function normalizeHarness(files: HarnessFiles): HarnessFiles {
  return Object.fromEntries(Object.entries(files)
    .filter(([path, body]) => !(ALWAYS_ON as readonly string[]).includes(path) || body.trim())
    .sort(([a], [b]) => a.localeCompare(b)));
}

export function sameHarness(a: HarnessFiles, b: HarnessFiles): boolean {
  return JSON.stringify(normalizeHarness(a)) === JSON.stringify(normalizeHarness(b));
}

export function frontmatter(text: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(text.slice(0, 600))?.[1];
}

export function withoutFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export const skillNames = (files: HarnessFiles) => Object.keys(files).flatMap(p => SKILL.exec(p)?.[1] ?? []).sort();
export const subagentNames = (files: HarnessFiles) => Object.keys(files).flatMap(p => SUBAGENT.exec(p)?.[1] ?? []).sort();
export const alwaysOnText = (files: HarnessFiles) => ALWAYS_ON.map(p => files[p] ?? "").join("\n\n");

/** The prompt text a solver sees: always-on files, then an index of the on-demand components it can reach. */
export function harnessInstructions(files: HarnessFiles): string {
  const parts = ALWAYS_ON.map(p => files[p]?.trim() ?? "").filter(Boolean);
  const index = (names: string[], path: (name: string) => string) =>
    names.map(name => `- \`${name}\`: ${frontmatter(files[path(name)], "description") ?? "(no description)"}`).join("\n");
  const skills = skillNames(files);
  if (skills.length) parts.push(`# AVAILABLE SKILLS\nRead \`${HARNESS_ROOT}/skills/<name>/SKILL.md\` when the situation matches:\n${index(skills, name => `skills/${name}/SKILL.md`)}`);
  const delegates = subagentNames(files);
  if (delegates.length) parts.push(`# AVAILABLE SUBAGENTS\nDelegate with the \`subagent\` tool when the situation matches:\n${index(delegates, name => `sub_agents/${name}/AGENT.md`)}`);
  const scripts = Object.keys(files).filter(p => SCRIPT.test(p)).map(p => p.slice("scripts/".length)).sort();
  if (scripts.length) parts.push(`# HELPER SCRIPTS\nAvailable at \`${HARNESS_ROOT}/scripts/\`: ${scripts.join(", ")}\nRun with \`node ${HARNESS_ROOT}/scripts/<name>.mjs\`.`);
  return parts.join("\n\n---\n\n");
}

/** Give every skill a trigger line in always-on text, skipping one that would exceed the cap; returns the names repaired. */
export function autotrigger(files: HarnessFiles): { files: HarnessFiles; triggered: string[] } {
  const out = { ...files };
  const triggered: string[] = [];
  for (const name of skillNames(out)) {
    if (alwaysOnText(out).includes(name)) continue;
    const desc = (frontmatter(out[`skills/${name}/SKILL.md`], "description") ?? `the ${name} workflow applies`).replace(/\.+$/, "");
    const line = triggerLine(name, desc);
    if (alwaysOnText(out).length + line.length + 2 > ALWAYS_ON_MAX) continue;
    const current = out[TRIGGER_FILE] ?? "";
    out[TRIGGER_FILE] = current.trim() ? `${current.trimEnd()}\n${line}` : line;
    triggered.push(name);
  }
  return { files: out, triggered };
}

export function inventory(files: HarnessFiles): string {
  const counts = { skills: skillNames(files).length, sub_agents: subagentNames(files).length,
    scripts: Object.keys(files).filter(p => SCRIPT.test(p)).length, plugins: Object.keys(files).filter(p => PLUGIN.test(p)).length };
  const parts = Object.entries(counts).filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}`);
  return `${parts.join(", ") || "always-on edits only"}; ${alwaysOnText(files).trim().length.toLocaleString("en-US")} always-on chars`;
}

async function parseError(path: string, body: string, signal?: AbortSignal): Promise<string | undefined> {
  try { await runProcess(process.execPath, ["--check", "--input-type=module"], { input: body, signal, timeoutMs: 20000 }); return undefined; }
  catch (error) {
    if (signal?.aborted) throw error;
    const lines = String((error as Error).message).split("\n");
    const reason = lines.find(line => /^\w*Error\b/.test(line)) ?? lines.filter(Boolean).at(-1) ?? "";
    return `${path} does not parse: ${reason.slice(0, 160)}`;
  }
}

/**
 * The semantic checks a proposal must pass before any rollout. `provided` lists the
 * workspace-relative files the runtime already supplies, so their invocation is allowed.
 */
export async function checkHarness(files: HarnessFiles, options: { provided?: Set<string>; signal?: AbortSignal } = {}): Promise<void> {
  const errors: string[] = [];
  const always = alwaysOnText(files);
  if (always.length > ALWAYS_ON_MAX) errors.push(`always-on content is ${always.length} chars, over the ${ALWAYS_ON_MAX} cap; every always-on token competes with the solver's output budget`);
  for (const name of skillNames(files)) {
    const text = files[`skills/${name}/SKILL.md`];
    if (!frontmatter(text, "description")) errors.push(`skills/${name}/SKILL.md needs a \`description:\` in its frontmatter naming the situation it handles; the runtime advertises skills by it`);
    const declared = frontmatter(text, "name");
    if (declared && declared !== name) errors.push(`skills/${name}/SKILL.md frontmatter \`name: ${declared}\` must match its directory (\`name: ${name}\`) or be removed`);
    if (!always.includes(name)) errors.push(`skill '${name}' is never named in the always-on text, so the agent will not know to invoke it -- an untriggered skill is dead weight. Fix it by adding a trigger line naming \`${name}\` to systemprompt.md or guardrails.md, e.g. "When <the situation this skill handles>, read \`${HARNESS_ROOT}/skills/${name}/SKILL.md\` and follow it."`);
  }
  for (const name of subagentNames(files)) {
    if (!frontmatter(files[`sub_agents/${name}/AGENT.md`], "description")) errors.push(`sub_agents/${name}/AGENT.md needs a \`description:\` in its frontmatter`);
  }
  for (const [path, body] of Object.entries(files)) {
    if (!(SKILL.test(path) || (ALWAYS_ON as readonly string[]).includes(path))) continue;
    for (const match of body.matchAll(SCRIPT_REF)) {
      const ref = match[1].replace(/^\.\//, "");
      if (ref.startsWith(`${HARNESS_ROOT}/`)) {
        if (!files[ref.slice(HARNESS_ROOT.length + 1)]) errors.push(`${path} invokes \`${ref}\` but that file is not in the harness`);
      } else if (!options.provided?.has(ref)) {
        errors.push(files[ref]
          ? `${path} invokes \`${ref}\`, but harness files are mounted under ${HARNESS_ROOT}/: invoke it as \`${HARNESS_ROOT}/${ref}\``
          : `${path} invokes \`${ref}\`, which neither the harness nor the workspace provides`);
      }
    }
  }
  for (const [path, body] of Object.entries(files)) {
    for (const marker of GRADER_MARKERS) if (path.includes(marker) || body.includes(marker)) errors.push(`${path} contains grader-verdict marker ${marker}; remove it`);
  }
  const parsed = await Promise.all(Object.entries(files)
    .filter(([path]) => SCRIPT.test(path))
    .map(([path, body]) => parseError(path, body, options.signal)));
  errors.push(...parsed.filter((e): e is string => Boolean(e)));
  if (errors.length) throw new Error(errors.join(" | "));
}

export async function writeHarness(root: string, files: HarnessFiles, options: { placeholders?: boolean } = {}): Promise<void> {
  const all = options.placeholders ? { ...Object.fromEntries(ALWAYS_ON.map(p => [p, ""])), ...files } : files;
  for (const [path, body] of Object.entries(validateHarness(all))) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
}

/** Read a harness directory, separating files on the editable surface from rejected ones. */
export async function readTree(root: string): Promise<{ files: HarnessFiles; rejected: string[] }> {
  const files: HarnessFiles = {};
  const rejected: string[] = [];
  async function visit(dir: string) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, item.name), rel = relative(root, path).split("\\").join("/");
      if (item.isDirectory()) await visit(path);
      else if (!item.isFile() || !isAllowed(rel)) rejected.push(rel);
      else files[rel] = await readFile(path, "utf8");
    }
  }
  await visit(root);
  return { files: normalizeHarness(files), rejected };
}

export async function readHarness(path: string): Promise<HarnessFiles> {
  if ((await lstat(path)).isFile()) return validateHarness({ "systemprompt.md": await readFile(path, "utf8") });
  const { files, rejected } = await readTree(path);
  if (rejected.length) throw new Error(`Files outside the harness surface: ${rejected.slice(0, 8).join(", ")}`);
  return validateHarness(files);
}

function lineDiff(before: string[], after: string[]): string[] {
  if (before.length * after.length > 4_000_000) return [`@@ ${before.length} -> ${after.length} lines (too large to diff line by line)`];
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--)
    table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { out.push(` ${before[i]}`); i++; j++; }
    else if (j < after.length && (i === before.length || table[i][j + 1] >= table[i + 1][j])) out.push(`+${after[j++]}`);
    else out.push(`-${before[i++]}`);
  }
  return out.filter((line, index, all) => line[0] !== " " || all.slice(Math.max(0, index - 3), index + 4).some(l => l[0] !== " "));
}

/** A readable diff of two trees; unchanged files are omitted. */
export function diffHarness(before: HarnessFiles, after: HarnessFiles, labels = ["current", "candidate"]): string {
  const a = normalizeHarness(before), b = normalizeHarness(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(path => a[path] !== b[path]).map(path => [
    `--- ${a[path] === undefined ? "/dev/null" : `${labels[0]}/${path}`}`,
    `+++ ${b[path] === undefined ? "/dev/null" : `${labels[1]}/${path}`}`,
    ...lineDiff(a[path]?.split("\n") ?? [], b[path]?.split("\n") ?? []),
  ].join("\n")).join("\n") || "(no differences)";
}
