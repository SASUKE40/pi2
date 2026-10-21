import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { HarnessFiles } from "./harness.js";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Make independent copies, rebasing internal links without copying Git or run state. */
export async function copyWorkspace(source: string, destination: string, excluded?: string): Promise<void> {
  const root = await realpath(source);
  if (contains(root, resolve(destination)) && (!excluded || !contains(excluded, resolve(destination)))) {
    throw new Error("The copy destination must be outside the source or inside the excluded state directory");
  }

  async function copy(from: string, to: string, ancestors: Set<string>, validateOnly = false): Promise<void> {
    const target = await realpath(from);
    if (excluded && (contains(excluded, from) || contains(excluded, target))) return;
    if (!contains(root, target)) throw new Error(`External symlink is not supported: ${from}`);
    if (relative(root, target).split(sep).includes(".git")) return;
    const info = await lstat(from);
    const resolvedInfo = info.isSymbolicLink() ? await stat(from) : info;
    if (resolvedInfo.isDirectory()) {
      if (ancestors.has(target)) throw new Error(`Symlink cycle is not supported: ${from}`);
      const next = new Set([...ancestors, target]);
      if (!validateOnly && !info.isSymbolicLink()) await mkdir(to, { recursive: true });
      for (const name of (await readdir(from)).sort()) {
        if (name !== ".git") await copy(join(from, name), join(to, name), next, validateOnly || info.isSymbolicLink());
      }
    } else if (resolvedInfo.isFile()) {
      if (!validateOnly && !info.isSymbolicLink()) await copyFile(from, to, constants.COPYFILE_FICLONE);
    } else {
      throw new Error(`Unsupported workspace entry (expected a file or directory): ${from}`);
    }
    if (!validateOnly && info.isSymbolicLink()) {
      const copiedTarget = join(destination, relative(root, target));
      await symlink(relative(dirname(to), copiedTarget), to, resolvedInfo.isDirectory() ? "dir" : "file");
    }
  }
  await copy(root, destination, new Set());
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const pending = `${path}.${randomUUID()}.tmp`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`);
  await rename(pending, path);
}

export interface MemoryEntry {
  runId: string;
  instructions: string;
  lesson: string;
  evidence: string;
  files?: HarnessFiles;
}

export async function readMemory(path: string, limit = 5): Promise<MemoryEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: MemoryEntry[] = text.split("\n").filter((line) => line.trim()).map((line) => {
    const entry = JSON.parse(line);
    if (!entry || !["runId", "instructions", "lesson", "evidence"].every((key) => typeof entry[key] === "string")) {
      throw new Error(`Invalid learning history: ${path}`);
    }
    return entry as MemoryEntry;
  });
  return limit === Infinity ? entries : entries.slice(-limit);
}

export async function appendMemory(path: string, entry: MemoryEntry): Promise<void> {
  // The caller holds the state-directory process lock. Rename prevents a crash leaving a partial JSONL record.
  let previous = "";
  try { previous = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pending = `${path}.${randomUUID()}.tmp`;
  await writeFile(pending, previous + `${JSON.stringify(entry)}\n`);
  await rename(pending, path);
}
