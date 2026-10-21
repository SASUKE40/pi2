import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type HarnessFiles = Record<string, string>;
const alwaysOn = ["systemprompt.md", "guardrails.md", "memory.md", "tool_guidance.md"];
export const HARNESS_FORMAT = `The harness is a complete files object (path -> UTF-8 contents).
Allowed paths: systemprompt.md, guardrails.md, memory.md, tool_guidance.md,
skills/<name>/SKILL.md, skills/<name>/scripts/<file>, scripts/<file>,
sub_agents/<name>.md, plugins/<name>.mjs. Names use letters, numbers, _ and -.
Skills must describe when they apply. Scripts and skills live under .pi2-harness/ at execution time.
Subagent instructions create named delegates callable with the subagent tool.
Plugins default-export a function receiving { defineExtension, defineTool, hook, section, ToolTask, Type }
and returning a Pi Durable extension. Prefer prompt/skill/script changes unless executable hooks are needed.
Always-on files are prompt guidance; guardrails.md is not an OS security policy.
Keep each file under 64000 characters and the whole harness under 256000. Do not include task answers.`;

export function validateHarness(value: unknown): HarnessFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected harness files object");
  const files: HarnessFiles = {};
  let size = 0;
  for (const [path, body] of Object.entries(value)) {
    const allowed = alwaysOn.includes(path) || /^(?:scripts\/[\w-]+\.(?:py|sh|js|mjs)|plugins\/[\w-]+\.mjs|sub_agents\/[\w-]+\.md|skills\/[\w-]+\/(?:SKILL\.md|scripts\/[\w.-]+))$/.test(path);
    if (!allowed || path.includes("..") || typeof body !== "string" || body.length > 64000) throw new Error(`Invalid harness file: ${path}`);
    size += body.length;
    if (size > 256000) throw new Error("Harness exceeds 256000 characters");
    files[path] = body;
  }
  return files;
}

export async function writeHarness(root: string, files: HarnessFiles): Promise<void> {
  for (const [path, body] of Object.entries(validateHarness(files))) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
}

export async function readHarness(path: string): Promise<HarnessFiles> {
  if ((await lstat(path)).isFile()) return validateHarness({ "systemprompt.md": await readFile(path, "utf8") });
  const files: HarnessFiles = {};
  async function visit(dir: string, prefix = "") {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error(`Harness symlinks are not supported: ${rel}`);
      if (item.isDirectory()) await visit(join(dir, item.name), rel + "/");
      else files[rel] = await readFile(join(dir, item.name), "utf8");
    }
  }
  await visit(path);
  return validateHarness(files);
}

export function harnessInstructions(files: HarnessFiles): string {
  const sections = alwaysOn.filter(p => files[p]).map(p => `## ${p}\n${files[p]}`);
  const skills = Object.keys(files).filter(p => p.endsWith("/SKILL.md"));
  if (skills.length) sections.push(`Available skills: inspect the relevant SKILL.md before working:\n${skills.map(p => `.pi2-harness/${p}`).join("\n")}`);
  const scripts = Object.keys(files).filter(p => p.startsWith("scripts/"));
  if (scripts.length) sections.push(`Reusable scripts:\n${scripts.map(p => `.pi2-harness/${p}`).join("\n")}`);
  return sections.join("\n\n");
}
