import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inventory, writeHarness } from "./harness.js";
import type { MemoryEntry } from "./storage.js";

export function experienceMarkdown(entry: MemoryEntry): string {
  return [
    `# ${entry.runId}`, "",
    `- task: ${entry.task.split("\n")[0].slice(0, 200)}`,
    `- adopted: \`${entry.adopted}\``,
    `- components: ${inventory(entry.files)}`, "",
    ...(entry.why.trim() ? ["## Why this was chosen", entry.why.trim(), ""] : []),
    ...(entry.edits.trim() ? ["## What each edit did", entry.edits.trim(), ""] : []),
    "## Transferable lesson",
    ...(["cue", "lesson", "evidence", "confidence"] as const).filter(key => entry[key]?.trim()).map(key => `- **${key}**: ${entry[key].trim()}`),
    "",
  ].join("\n");
}

/** Materialise entries as INDEX.md plus harnesses/<run>/{harness/,EXPERIENCE.md}. */
export async function renderLibrary(dir: string, entries: MemoryEntry[], domain: string): Promise<void> {
  await rm(join(dir, "harnesses"), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const entry of entries) {
    const entryDir = join(dir, "harnesses", entry.runId);
    await rm(join(entryDir, "harness"), { recursive: true, force: true });
    await mkdir(join(entryDir, "harness"), { recursive: true });
    await writeHarness(join(entryDir, "harness"), entry.files);
    await writeFile(join(entryDir, "EXPERIENCE.md"), experienceMarkdown(entry));
  }
  const rows = [
    `# Library — ${domain}`, "",
    "Each entry is an earlier task in THIS domain whose harness was adopted, stored with its FULL component tree and why it was picked. Browse this index, then open the entries that look relevant to the matter in front of you.", "",
  ];
  if (!entries.length) rows.push("_(empty — this is the first task in this domain)_");
  for (const entry of entries) rows.push(
    `## \`harnesses/${entry.runId}/\``,
    `- harness: \`harnesses/${entry.runId}/harness/\` — ${inventory(entry.files)}`,
    `- why:     \`harnesses/${entry.runId}/EXPERIENCE.md\``,
    `- cue:     ${entry.cue}`, "",
  );
  await writeFile(join(dir, "INDEX.md"), rows.join("\n"));
}
