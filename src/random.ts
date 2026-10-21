import { createHash } from "node:crypto";

/** Stable order, independent of input enumeration and JavaScript random state. */
export function seededOrder<T>(items: T[], seed: string, key: (item: T) => string): T[] {
  const hash = (item: T) => createHash("sha256").update(`${seed}\0${key(item)}`).digest("hex");
  return [...items].sort((a, b) => hash(a).localeCompare(hash(b)) || key(a).localeCompare(key(b)));
}
