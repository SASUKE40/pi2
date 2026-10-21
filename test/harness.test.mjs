import assert from "node:assert/strict";
import test from "node:test";
import { validateHarness, harnessInstructions } from "../dist/harness.js";

test("harness exposes eight components and rejects escaped paths and oversized files", () => {
  const files = validateHarness({
    "systemprompt.md": "Solve the task", "guardrails.md": "Verify facts", "memory.md": "Remember units",
    "tool_guidance.md": "Read before writing", "skills/totals/SKILL.md": "Use for summing ledgers",
    "scripts/check.py": "print(1)", "sub_agents/reviewer.md": "Review totals",
    "plugins/verify.mjs": "export default ({defineExtension}) => defineExtension({name:'verify'})",
  });
  assert.equal(Object.keys(files).length, 8);
  assert.match(harnessInstructions(files), /\.pi2-harness\/skills\/totals\/SKILL.md/);
  for (const bad of ["../escape", "/tmp/escape", "skills/test/scripts/../escape", "__proto__", "arbitrary.txt"]) {
    assert.throws(() => validateHarness({ [bad]: "oops" }), /Invalid harness file/);
  }
  assert.throws(() => validateHarness({ "systemprompt.md": "x".repeat(64001) }), /Invalid harness file/);
});
