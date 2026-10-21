import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grade, tasks } from "../benchmark/tasks.mjs";

// Independent reference submissions verify that the external grader accepts correct outputs.
const solutions = {
  csv: `export function parseCSV(text) {
    if (text === '') return [];
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && ch === ',') { row.push(field); field = ''; }
      else if (!quoted && (ch === '\\n' || ch === '\\r')) {
        row.push(field); rows.push(row); row = []; field = '';
        if (ch === '\\r' && text[i + 1] === '\\n') i++;
        if (i === text.length - 1) return rows;
      } else field += ch;
    }
    row.push(field); rows.push(row); return rows;
  }`,
  intervals: `export function mergeIntervals(intervals) {
    const sorted = intervals.map(x => [...x]).sort((a,b) => a[0] - b[0]);
    const out = [];
    for (const pair of sorted) {
      const last = out.at(-1);
      if (last && pair[0] <= last[1]) last[1] = Math.max(last[1], pair[1]);
      else out.push(pair);
    }
    return out;
  }`,
  ledger: `export function reconcile(events) {
    const latest = new Map(), totals = new Map();
    for (const event of events) {
      if (!latest.has(event.id) || event.revision >= latest.get(event.id).revision) latest.set(event.id, event);
    }
    for (const event of latest.values()) {
      if (event.status === 'settled') totals.set(event.currency, (totals.get(event.currency) ?? 0n) + BigInt(event.amount.replace('.', '')));
    }
    return Object.fromEntries([...totals].map(([currency, total]) => {
      const abs = total < 0n ? -total : total;
      return [currency, (total < 0n ? '-' : '') + abs / 100n + '.' + String(abs % 100n).padStart(2, '0')];
    }));
  }`,
};

test("benchmark graders accept correct solutions and reject incomplete and broken ones", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi2-grade-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const task of tasks) {
    await writeFile(join(cwd, task.file), solutions[task.id]);
    const good = grade(task, cwd);
    assert.equal(good.passed, 12, JSON.stringify(good));
    assert.equal(good.allPassed, true);
    await writeFile(join(cwd, task.file), `export function ${task.name}() { return ${task.id === "ledger" ? "{}" : "[]"}; }`);
    const wrong = grade(task, cwd);
    assert.ok(wrong.passed < wrong.total);
    assert.equal(wrong.allPassed, false);
    await writeFile(join(cwd, task.file), "invalid syntax (");
    assert.equal(grade(task, cwd).passed, 0);
  }
});

test("interval grading detects mutation and aliased output", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi2-grade-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = tasks.find(t => t.id === "intervals");
  await writeFile(join(cwd, task.file), solutions.intervals.replace("intervals.map(x => [...x])", "intervals"));
  const result = grade(task, cwd);
  assert.ok(result.failures.some(f => /input mutated|output aliases input/.test(f.error)));
});
