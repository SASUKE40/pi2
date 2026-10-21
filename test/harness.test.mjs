import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkHarness, diffHarness, harnessInstructions, readTree, validateHarness, writeHarness } from "../dist/harness.js";
import { benchPrompts, parseChoice, parseReflection, propose, select } from "../dist/prompts.js";

const FULL = {
  "systemprompt.md": "Solve the task", "guardrails.md": "Verify facts", "LongTermMEMORY.md": "Remember units",
  "tool_descriptions/tool_guidance.md": "Read before writing",
  "skills/totals/SKILL.md": "---\nname: totals\ndescription: when summing ledgers\n---\nRun python3 .pi2-harness/skills/totals/scripts/sum.py",
  "skills/totals/scripts/sum.py": "print(1)\n", "scripts/check.py": "print(2)\n",
  "sub_agents/reviewer/AGENT.md": "---\ndescription: review a total against the source\n---\nReview totals",
  "plugin/verify.mjs": "export default ({ defineExtension }) => defineExtension({ name: 'verify' });\n",
};

test("the tree uses the paper's component paths and rejects everything else", async () => {
  const files = validateHarness(FULL);
  assert.equal(Object.keys(files).length, 9);
  const text = harnessInstructions(files);
  assert.match(text, /## systemprompt\.md\nSolve the task/);
  assert.match(text, /`totals`: when summing ledgers \(\.pi2-harness\/skills\/totals\/SKILL\.md\)/);
  assert.match(text, /\.pi2-harness\/scripts\/check\.py/);
  assert.match(text, /`reviewer`: review a total/);
  await checkHarness(files);
  for (const bad of ["../escape", "/tmp/escape", "skills/test/scripts/../escape", "__proto__", "arbitrary.txt", "memory.md",
    "tool_guidance.md", "sub_agents/reviewer.md", "plugins/verify.mjs", "skills/Totals/SKILL.md", "skills/totals/helper.py"]) {
    assert.throws(() => validateHarness({ [bad]: "oops" }), /Invalid harness file/, bad);
  }
  assert.throws(() => validateHarness({ "systemprompt.md": "x".repeat(64001) }), /Invalid harness file/);
});

test("semantic validation names what is wrong", async () => {
  const reject = (files, pattern, options) => assert.rejects(checkHarness(files, options), pattern);
  await reject({ "skills/a/SKILL.md": "no frontmatter" }, /skills\/a\/SKILL\.md needs a `description:`/);
  await reject({ "skills/a/SKILL.md": "---\nname: b\ndescription: x\n---" }, /must match its directory/);
  await reject({ "sub_agents/r/AGENT.md": "Review" }, /sub_agents\/r\/AGENT\.md needs a `description:`/);
  await reject({ "systemprompt.md": "Run python3 .pi2-harness/scripts/missing.py" }, /not in the harness/);
  await reject({ "systemprompt.md": "Run python3 scripts/check.py", "scripts/check.py": "print(1)" }, /invoke it as `\.pi2-harness\/scripts\/check\.py`/);
  await checkHarness({ "systemprompt.md": "Run python3 scripts/read_doc.py PATH" }, { provided: new Set(["scripts/read_doc.py"]) });
  await reject({ "systemprompt.md": "x".repeat(24001) }, /over the 24000 cap/);
  await reject({ "guardrails.md": 'never print "pass_rate"' }, /grader-verdict marker/);
  await reject({ "scripts/bad.py": "def broken(:\n" }, /scripts\/bad\.py does not parse/);
  await reject({ "plugin/bad.mjs": "export default (" }, /plugin\/bad\.mjs does not parse/);
});

test("trees round-trip through disk with placeholders, and diffs show only changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi2-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeHarness(root, { "systemprompt.md": "a\nb\nc" }, { placeholders: true });
  await mkdir(join(root, "skills", "x"), { recursive: true });
  await writeFile(join(root, "skills", "x", "notes.txt"), "loose helper");
  const { files, rejected } = await readTree(root);
  assert.deepEqual(files, { "systemprompt.md": "a\nb\nc" });
  assert.deepEqual(rejected, ["skills/x/notes.txt"]);
  const diff = diffHarness(files, { "systemprompt.md": "a\nB\nc", "scripts/x.py": "print(1)" }, ["base", "probe-inv"]);
  assert.match(diff, /--- \/dev\/null\n\+\+\+ probe-inv\/scripts\/x\.py\n\+print\(1\)/);
  assert.match(diff, /--- base\/systemprompt\.md\n\+\+\+ probe-inv\/systemprompt\.md\n a\n\+B\n-b\n c|--- base\/systemprompt\.md\n\+\+\+ probe-inv\/systemprompt\.md\n a\n-b\n\+B\n c/);
  assert.equal(diffHarness(files, files), "(no differences)");
});

test("prompt packs and reply parsers follow the upstream contract", () => {
  const tts = benchPrompts(JSON.stringify({ prompt_pack: "tts", domain_word: "profession", deliverable_word: "report", work: "W" }));
  assert.match(propose(tts, "DOM", { k: 2, index: 1 }), /DOMAIN harness editor[\s\S]*candidate 1 of 2[\s\S]*EDITABLE HARNESS SURFACE/);
  assert.match(select(tts, 3), /COVERAGE[\s\S]*CORRECTNESS[\s\S]*FIDELITY/);
  const plain = benchPrompts("Focus on reconciliations");
  assert.match(propose(plain, "INV"), /# DOMAIN AND TASK LENS\n\nFocus on reconciliations/);
  assert.match(select(plain, 2), /2\. CONFORMANCE[\s\S]*7\. VALUES ARE VALUES/);
  assert.doesNotMatch(select(benchPrompts('{"selection_conformance":"full"}'), 2), /7\. VALUES/);
  assert.doesNotMatch(select(benchPrompts('{"selection_conformance":"value_only"}'), 2), /2\. CONFORMANCE/);

  assert.deepEqual(parseChoice("<why>\nA wins\n</why>\n```choice\nA\n```", ["A", "B"]), { id: "A", why: "A wins" });
  assert.throws(() => parseChoice("```choice\nC\n```", ["A", "B"]), /not one of A, B/);
  assert.throws(() => parseChoice("A", ["A"]), /no ```choice block/);
  assert.equal(parseReflection("<edits>\nrow\n</edits>\nNO_ENTRY").experience, null);
  assert.equal(parseReflection("<experience>\ncue: c\nlesson: l\n</experience>").experience, null);
  assert.deepEqual(parseReflection("<experience>\ncue: c\nlesson: l\nevidence: e\nconfidence: low\n</experience>").experience,
    { cue: "c", lesson: "l", evidence: "e", confidence: "low" });
  assert.throws(() => parseReflection("nothing"), /NO_ENTRY/);
});
