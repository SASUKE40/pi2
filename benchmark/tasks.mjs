import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// Checks stay outside execution workspaces and are never included in agent prompts.
export const tasks = [
  {
    id: "csv", name: "parseCSV", file: "solution.mjs",
    prompt: `Implement export function parseCSV(text) in solution.mjs without dependencies.
Return an array of rows, each an array of strings. Support comma separators, quoted fields,
doubled quotes inside quoted fields, and embedded commas and newlines inside quoted fields.
Recognize LF and CRLF row endings outside quotes; preserve characters inside quotes exactly.
Empty input returns []; empty fields are preserved. A final row terminator creates no extra row.
Blank lines represent a single empty field. Input is well-formed CSV; do not trim whitespace.
Examples: 'a,b\\n' => [['a','b']]; '"a,b",c' => [['a,b','c']].`,
    checks: [
      ["empty input", [""], []],
      ["plain row", ["a,b"], [["a", "b"]]],
      ["trailing newline", ["a,b\n"], [["a", "b"]]],
      ["empty fields", [",x,"], [["", "x", ""]]],
      ["quoted comma", ['"a,b",c'], [["a,b", "c"]]],
      ["escaped quotes", ['"say ""hi""",ok'], [['say "hi"', "ok"]]],
      ["quoted newline", ['"a\nb",c\nx,y'], [["a\nb", "c"], ["x", "y"]]],
      ["CRLF", ["a,b\r\nc,d\r\n"], [["a", "b"], ["c", "d"]]],
      ["preserve quoted CRLF", ['"a\r\nb",c\r\n'], [["a\r\nb", "c"]]],
      ["blank lines", ["\n\n"], [[""], [""]]],
      ["quoted empties", ['"",""\n'], [["", ""]]],
      ["spaces and unicode", [' α ," β "'], [[" α ", " β "]]],
    ],
  },
  {
    id: "intervals", name: "mergeIntervals", file: "solution.mjs",
    prompt: `Implement export function mergeIntervals(intervals) in solution.mjs without dependencies.
Input is an array of [start, end] pairs with finite numeric endpoints and start < end.
Return the union as sorted, non-overlapping pairs, merging overlapping or touching intervals.
Do not mutate the input or reuse its inner arrays in the output. Empty input returns [].
Example: [[5,7],[1,3],[3,6]] => [[1,7]].`,
    checks: [
      ["empty", [[]], []],
      ["single", [[[1, 2]]], [[1, 2]]],
      ["unsorted", [[[5, 7], [1, 2]]], [[1, 2], [5, 7]]],
      ["touching", [[[3, 5], [1, 3]]], [[1, 5]]],
      ["overlap", [[[1, 4], [2, 6]]], [[1, 6]]],
      ["contained", [[[1, 10], [2, 3], [4, 8]]], [[1, 10]]],
      ["chain", [[[8, 10], [1, 4], [3, 9]]], [[1, 10]]],
      ["duplicates", [[[1, 4], [1, 4]]], [[1, 4]]],
      ["negative", [[[-3, -1], [-5, -3], [2, 3]]], [[-5, -1], [2, 3]]],
      ["fractional", [[[0.1, 0.5], [0.4, 1.1], [1.2, 2]]], [[0.1, 1.1], [1.2, 2]]],
      ["equal starts", [[[1, 2], [1, 8], [1, 3]]], [[1, 8]]],
      ["independent output", [[[9, 10], [1, 3], [2, 5]]], [[1, 5], [9, 10]]],
    ],
  },
  {
    id: "ledger", name: "reconcile", file: "solution.mjs",
    prompt: `Implement export function reconcile(events) in solution.mjs without dependencies.
Each event is {id, revision, status, currency, amount}. For each id choose the highest revision;
ties choose the event appearing later in the input. Only then include events whose status is
'settled'. Sum their signed amounts by currency using exact decimal arithmetic (including
values larger than Number.MAX_SAFE_INTEGER). Amounts match /^-?\\d+\\.\\d{2}$/ and revisions are
nonnegative integers. Return a plain object mapping each included currency to a signed decimal
string with exactly two digits after the decimal point and no plus sign. Zero is '0.00'.
Include a currency with zero net total if it has settled events. Do not mutate the input.
Empty input returns {}. All inputs are well formed; ids and currencies are ordinary strings.`,
    checks: ledgerChecks(),
  },
];

function ledgerChecks() {
  const e = (id, amount, revision = 0, status = "settled", currency = "USD") => ({ id, amount, revision, status, currency });
  return [
    ["empty", [[]], {}],
    ["single", [[e("a", "12.34")]], { USD: "12.34" }],
    ["signed", [[e("a", "12.34"), e("b", "-2.35")]], { USD: "9.99" }],
    ["exact cents", [[e("a", "0.10"), e("b", "0.20")]], { USD: "0.30" }],
    ["highest revision", [[e("a", "8.00", 2), e("a", "3.00", 1)]], { USD: "8.00" }],
    ["latest tie", [[e("a", "8.00", 2), e("a", "3.00", 2)]], { USD: "3.00" }],
    ["cancel after settling", [[e("a", "8.00"), e("a", "8.00", 1, "cancelled")]], {}],
    ["ignore pending", [[e("a", "8.00", 0, "pending")]], {}],
    ["currency change", [[e("a", "5.00"), e("a", "7.00", 1, "settled", "EUR"), e("b", "2.00")]], { EUR: "7.00", USD: "2.00" }],
    ["zero", [[e("a", "3.15"), e("b", "-3.15"), e("c", "-0.00")]], { USD: "0.00" }],
    ["large exact sum", [[e("a", "9007199254740993.99"), e("b", "0.02")]], { USD: "9007199254740994.01" }],
    ["negative cents", [[e("a", "-0.01"), e("b", "-0.09")]], { USD: "-0.10" }],
  ];
}

export function failedGrade(task, error) {
  return { passed: 0, total: task.checks.length, allPassed: false, error };
}

export function grade(task, workspace) {
  // A separate bounded process keeps a broken submission from stopping the entire suite.
  const source = `
    import assert from 'node:assert/strict';
    const { name, checks } = JSON.parse(process.argv[2]);
    const failures = [];
    try {
      const fn = (await import(process.argv[1]))[name];
      for (const [label, args, expected] of checks) {
        try {
          const input = structuredClone(args);
          const actual = await fn(...input);
          assert.deepEqual(actual, expected);
          assert.deepEqual(input, args, 'input mutated');
          if (name === 'mergeIntervals') assert.ok(actual.every(row => !input[0].includes(row)), 'output aliases input');
        } catch (error) { failures.push({ name: label, error: String(error).slice(0, 1000) }); }
      }
    } catch (error) {
      failures.push(...checks.map(([label]) => ({ name: label, error: String(error).slice(0, 1000) })));
    }
    const passed = checks.length - failures.length;
    process.stdout.write('\\nPI2_GRADE:' + JSON.stringify({passed, total: checks.length, allPassed: passed === checks.length, failures}));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source,
    pathToFileURL(join(workspace, task.file)).href,
    JSON.stringify({ name: task.name, checks: task.checks }),
  ], { cwd: workspace, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) return failedGrade(task, String(result.error ?? result.stderr));
  try {
    const value = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("\nPI2_GRADE:") + 11));
    if (!Number.isInteger(value.passed) || value.total !== task.checks.length || value.passed < 0 || value.passed > value.total) throw new Error("Invalid grade");
    return value;
  } catch { return failedGrade(task, "Grader returned no valid result"); }
}
