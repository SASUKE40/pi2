import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { autotrigger, checkHarness, diffHarness, harnessInstructions, readTree, validateHarness, writeHarness } from "../dist/harness.js";
import { benchPrompts, parseChoice, parseReflection, propose, select } from "../dist/prompts.js";

const FULL = {
  "systemprompt.md": "Solve the task", "guardrails.md": "When summing ledgers, read `.pi2-harness/skills/totals/SKILL.md`.", "LongTermMEMORY.md": "Remember units",
  "tool_descriptions/tool_guidance.md": "Read before writing",
  "skills/totals/SKILL.md": "---\nname: totals\ndescription: when summing ledgers\n---\nRun node .pi2-harness/skills/totals/scripts/sum.mjs",
  "skills/totals/scripts/sum.mjs": "console.log(1);\n", "scripts/check.mjs": "console.log(2);\n",
  "sub_agents/reviewer/AGENT.md": "---\ndescription: review a total against the source\n---\nReview totals",
  "plugin/verify.mjs": "export default ({ defineExtension }) => defineExtension({ name: 'verify' });\n",
};

test("the tree uses the paper's component paths and rejects everything else", async () => {
  const files = validateHarness(FULL);
  assert.equal(Object.keys(files).length, 9);
  const text = harnessInstructions(files);
  assert.match(text, /^Solve the task\n\n---\n\nWhen summing ledgers/);
  assert.match(text, /# AVAILABLE SKILLS\n.*\n- `totals`: when summing ledgers/);
  assert.match(text, /# AVAILABLE SUBAGENTS\n.*\n- `reviewer`: review a total/);
  assert.match(text, /# HELPER SCRIPTS\nAvailable at `\.pi2-harness\/scripts\/`: check\.mjs\nRun with `node \.pi2-harness\/scripts\/<name>\.mjs`\./);
  await checkHarness(files);
  for (const bad of ["../escape", "/tmp/escape", "skills/test/scripts/../escape", "__proto__", "arbitrary.txt", "memory.md",
    "tool_guidance.md", "sub_agents/reviewer.md", "plugins/verify.mjs", "skills/Totals/SKILL.md", "skills/totals/helper.mjs",
    "scripts/check.sh", "scripts/check.py", "scripts/check.js", "scripts/check-totals.mjs"]) {
    assert.throws(() => validateHarness({ [bad]: "oops" }), /Invalid harness file/, bad);
  }
  assert.throws(() => validateHarness({ "systemprompt.md": "x".repeat(64001) }), /Invalid harness file/);
});

test("semantic validation names what is wrong", async () => {
  const reject = (files, pattern, options) => assert.rejects(checkHarness(files, options), pattern);
  await reject({ "skills/a/SKILL.md": "no frontmatter" }, /skills\/a\/SKILL\.md needs a `description:`/);
  await reject({ "skills/a/SKILL.md": "---\nname: b\ndescription: x\n---" }, /must match its directory/);
  await reject({ "skills/totals/SKILL.md": "---\ndescription: x\n---" }, /skill 'totals' is never named in the always-on text/);
  await reject({ "sub_agents/r/AGENT.md": "Review" }, /sub_agents\/r\/AGENT\.md needs a `description:`/);
  await reject({ "systemprompt.md": "Run node .pi2-harness/scripts/missing.mjs" }, /not in the harness/);
  await reject({ "systemprompt.md": "Run node scripts/check.mjs", "scripts/check.mjs": "console.log(1);" }, /invoke it as `\.pi2-harness\/scripts\/check\.mjs`/);
  await checkHarness({ "systemprompt.md": "Run node scripts/read_doc.mjs PATH" }, { provided: new Set(["scripts/read_doc.mjs"]) });
  await reject({ "systemprompt.md": "x".repeat(24001) }, /over the 24000 cap/);
  await reject({ "guardrails.md": 'never print "pass_rate"' }, /grader-verdict marker/);
  await reject({ "scripts/bad.mjs": "export const = 1;\n" }, /scripts\/bad\.mjs does not parse: SyntaxError/);
});

test("autotrigger names every untriggered skill in guardrails.md within the always-on cap", async () => {
  const skill = { "skills/totals/SKILL.md": "---\ndescription: summing signed ledgers.\n---\nInclude credits." };
  const { files, triggered } = autotrigger({ ...skill, "guardrails.md": "Check units." });
  assert.deepEqual(triggered, ["totals"]);
  assert.equal(files["guardrails.md"], "Check units.\n- When summing signed ledgers, read `.pi2-harness/skills/totals/SKILL.md` and follow it.\n");
  await checkHarness(files);
  assert.deepEqual(autotrigger({ ...skill, "systemprompt.md": "Use totals." }).triggered, []);
  const full = autotrigger({ ...skill, "systemprompt.md": "x".repeat(23990) });
  assert.deepEqual(full.triggered, []);
  await assert.rejects(checkHarness(full.files), /never named in the always-on text/);
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
  const diff = diffHarness(files, { "systemprompt.md": "a\nB\nc", "scripts/x.mjs": "console.log(1);" }, ["base", "probe-inv"]);
  assert.match(diff, /--- \/dev\/null\n\+\+\+ probe-inv\/scripts\/x\.mjs\n\+console\.log\(1\);/);
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
  assert.deepEqual(parseReflection("nothing"), { edits: "", experience: null });
});
