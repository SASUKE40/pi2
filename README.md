# pi2

An implementation of [Harness²](https://github.com/google-research/harness2) built directly on
[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable),
`@earendil-works/pi-ai`, and `@earendil-works/chord` (pinned to 1.3.0).

Give it a task and a workspace. It runs reference executions, proposes general and domain-specific
harness changes, probes them on fresh copies, composes refinements, adopts a result, and records
supported lessons for later tasks. Model weights stay fixed. Editors never receive benchmark grades.

## Install and run

Requires Node.js 22.19 or newer, including its built-in SQLite support.

```sh
npm ci --ignore-scripts
npm run build

# Set your provider's API key in the environment, for example OPENAI_API_KEY.
npm start -- "Sum every signed amount in ledger.csv and write total.txt." \
  --cwd /path/to/task-files --model openai/gpt-5.4-mini

# Refine through three successive rounds, with a separate improvement model.
npm start -- "Complete the task" --cwd /path/to/task-files \
  --model provider/solver --improver-model provider/improver \
  --k 3 --mode sequential --domain accounting

# Resume using the original configuration and input snapshot.
npm start -- --resume /path/to/state/runs/run-XXXXXX
```

The compiled CLI is also available as `node dist/cli.js`. After building,
`npm link --ignore-scripts` makes `pi2` available globally.

```text
pi2 "task" [--cwd DIR] [--model provider/model] [--improver-model provider/model]
           [--thinking LEVEL] [--harness PATH] [--k N] [--mode parallel|sequential]
           [--workers N] [--domain NAME] [--state-dir DIR] [--timeout SECONDS]
pi2 --resume RUN_DIR [--workers N] [--timeout SECONDS]
```

Defaults: current workspace; `PI2_MODEL` or the first available pi-ai model; the same model for
execution and improvement; medium thinking; an empty harness; `k=1`; parallel recursion;
two workers; domain `default`; state under `~/.pi2/<canonical-workspace-hash>`; 600 seconds per stage.
`k` accepts 1–20 and workers accepts 1–32. `--help` works without credentials.

Authentication now comes from pi-ai providers. The old Pi coding CLI's login, settings, extensions,
and `models.json` are not automatically loaded. For custom endpoints or an application-owned
persistent OAuth credential store, set `PI2_MODELS_MODULE` to an ES module whose default export is
an async function returning a pi-ai `Models` collection. API keys stay outside run configuration.
The module is executable application code; use the same implementation when resuming a run.

## Harness components

`--harness` accepts a Markdown file (the initial system prompt) or a directory with these files:

```text
systemprompt.md
guardrails.md       # prompt constraints, not an OS policy
memory.md           # execution-time knowledge
tool_guidance.md    # guidance for using tools
skills/<name>/SKILL.md
skills/<name>/scripts/<file>
scripts/<name>.py|sh|js|mjs
sub_agents/<name>.md
plugins/<name>.mjs
```

Names use letters, numbers, `_`, and `-`. Proposals replace the entire file map. Paths, file types,
and sizes are validated; each file is limited to 64,000 characters and the total to 256,000.
The first four files form the execution instructions. Skills and scripts are installed under
`.pi2-harness/` in each execution copy and listed in the prompt. The agent reads relevant skills
and invokes scripts through its tools. The original workspace's `.pi2-harness/`, if present, is
replaced in the execution copies with the chosen harness.

Each subagent file defines a named specialist, invoked with `subagent({name, task})`. Its
conversation is owned by the tool task, shares that execution's workspace, and uses the solver
model. Its enabled tools are `read`, `write`, `edit`, and `bash`; it cannot recursively delegate.

Plugins default-export a factory that returns a Pi Durable extension. Factories receive the
runtime API, so generated plugins do not need to resolve Pi packages from the copied workspace:

```js
export default ({ defineExtension, defineTool, Type }) => defineExtension({
  name: "arithmetic",
  tools: [defineTool({
    name: "double",
    description: "Double a number",
    parameters: Type.Object({ value: Type.Number() }),
    execute: async ({ value }) => ({
      output: [{ type: "text", text: String(value * 2) }],
    }),
  })],
});
```

Factories also receive `hook`, `section`, and `ToolTask` for runtime hooks and prompt sections.
Plugins run as local JavaScript with the launching process's permissions. Guardrail text and
workspace copies are not a security sandbox. Use an externally isolated environment when needed.

## Refinement and evidence

Both modes start with `k` reference executions of the initial harness.

- **Parallel:** propose and probe `k` general and `k` domain candidates, then produce `k`
  independent compositions from the shared evidence pool.
- **Sequential:** run `k` successive Propose–Probe–Compose rounds, carrying the refined harness
  and all earlier evidence into the next round.

With `k>1`, a selector chooses among shuffled, anonymized composed outputs using their artifacts, without grades.
With `k=1`, the single composition is adopted. Reflection then saves a supported transferable
lesson or returns `null`. Normal runs use `4k` execution sessions and `3k` improvement sessions,
plus reflection and, when `k>1`, selection. Invalid proposal schemas get one corrective retry,
then retain the current harness. Invalid selections retry once and fall back to the first shuffled viable final;
invalid reflections retry once and save no lesson. Fallback reasons are recorded. Transport failures stop the workflow and can be resumed.

Task sessions use Pi Durable's `read`, `bash`, `edit`, and `write` tools plus harness extensions.
Editors and the selector have only the `read` tool. Their `evidence/INDEX.md` points to complete
traces, original inputs, actual execution workspaces (including images), and the prior library.
Prompt previews are bounded; the full text and artifact files remain available for reading.
Editors receive no shell or write tool, and their read tool resolves paths and rejects access
outside the prepared evidence tree. Selectors receive only anonymized answers and artifacts,
without candidate harnesses, traces, or library entries. These restrictions are not an OS sandbox
for solver tools or executable plugins.

Learning libraries are separated by domain, solver, improver, thinking level, mode, and budget.
Each stores an index, full adopted harnesses, and evidence-supported lessons. The last five
entries appear in prompt previews; all earlier entries are available in `evidence/library.json`.
Learning guides editors and does not silently replace the next task's initial harness. One process
at a time owns a state directory; Chord's process lock prevents concurrent writers.

## Persistence and failures

Each stage has a Pi Durable SQLite session. Model turns and tool results are persisted before
being returned. Completed workflow stages are checkpointed separately, so resume skips them.
Pending durable work continues after a crash. Completed tools are not repeated; an interrupted
tool follows Pi Durable's replay policy, so non-replay-safe side effects are not blindly rerun.
This is not a guarantee of exactly-once external effects.

```text
state/
  libraries/<experiment-hash>/
    INDEX.md, memory.jsonl
    run-…/harness/, lesson.json
  runs/run-…/
    config.json, status.json, memory-snapshot.json
    input/
    baseline/, probe-general/, probe-task/, composed/  # numbered when k > 1
      workspace/, session.sqlite
      request.json, response.json, status.json
      instructions.md, prompt.txt, answer.txt, trace.txt, messages.json, usage.json
    propose-general/, propose-task/, compose/, reflect/, select/
    result.json
```

The input snapshot includes dependency directories and excludes `.git` and the state directory.
Internal symlinks are rebased; external links, cycles, and special files are rejected. Use a
self-contained workspace and allow space for `4k` execution copies plus the input snapshot.
Outputs are never automatically applied to the original workspace.

Ctrl+C or a timeout closes active durable sessions and preserves pending work for `--resume`.
Resume uses the saved input and learning snapshots. Changes to task, initial harness, model,
thinking level, domain, budget, or mode are rejected. Worker count and timeout may change.
Version-1 instruction-only run directories cannot be resumed by this implementation. Legacy
workspace-level memory files are preserved but are not imported into the new experiment libraries.
A reflection failure preserves the composed artifacts; learning is committed only after successful
reflection, with duplicate run IDs excluded on recovery. Files and SQLite protect against process
crashes, not all power-loss scenarios. Run folders contain task data and transcripts.

## Quality benchmark

```sh
npm run bench -- --model provider/model
npm run bench -- --model provider/model --repeats 3
npm run bench -- --model provider/model --task csv --timeout 180
npm run bench -- --model zai-coding-cn/glm-5.3-flash --suite hard --thinking low --timeout 420
```

The exploratory `pi2-coding-v1` suite compares baseline and refined solutions for CSV parsing,
interval merging, and exact ledger reconciliation (12 checks each). It uses `k=1`, the same model
and starting files, and fresh learning state for every attempt. Checks run after refinement and
never enter editor feedback. They are withheld from prompts, not protected by an OS sandbox.
The suite measures single-task refinement, not learning across tasks.

`--suite hard` selects the local `pi2-hard-v1` stress suite: minimum-cost maximum flow with
disconnected negative cycles (76 checks), canonical three-way line merging (89 checks), and
snapshot transactions with read/prefix validation and savepoints (71 checks). The 236 checks
combine explicit edge cases and fixed seeded inputs. Small network expectations use exhaustive
enumeration and are cross-checked against a residual-network solver; larger cases have analytic
answers. Merge and transaction oracles have invariant and hand-calculated checks. This suite is
authored for this project; it is not an official Harness2 dataset or a calibrated difficulty scale.
The same isolation and post-refinement grading rules apply. Use `--task` to select one hard task
(`mincost-flow`, `three-way-merge`, or `mvcc`). GLM credentials use `ZAI_CODING_CN_API_KEY` for
the BigModel coding endpoint or `ZAI_API_KEY` with the `zai` provider for the international endpoint.

Reports under `.pi2/benchmarks/quality-*/report.json` contain paired improvements/regressions,
errors, per-stage timings, usage, estimated costs, source hashes, and schema fallback diagnostics.
Failed workflows count as failed refined attempts. The local runner stops an attempt on execution
failure, so a baseline timeout prevents refinement of that task; inspect stage status separately
from check scores. Usage includes subagents and compaction through the durable session ledger; missing
usage is `null`. Model-backed runs incur provider charges.

[Recorded quality results](benchmark/RESULTS.md) include real runs on Pi Durable. GLM-5.3-Flash
at low reasoning completed only 1/3 full workflows on the hard suite: transactions stayed at
71/71, flow timed out before refinement, and merge's final agent timed out despite its unfinished
artifact passing 89/89. No quality gain was demonstrated. An earlier Grok 4.3 ledger run passed
12/12 for both baseline and refinement. Historical GPT-5.4-mini measurements used the previous
coding-agent implementation.

## Official benchmark workflows

pi2 supports JobBench (`jb`), Harvey LAB (`lab`), and WorkBuddy's office, web, and code subsets
(`wb-office`, `wb-web`, `wb-code`). A Python bridge uses the pinned Harness2 dataset loaders,
domain guidance, document readers, and official judges. All solver and improvement calls use
Pi Durable. Setup installs benchmark environments, data, and required patches, without installing
an OpenCode or Codex executor. The three Pi packages remain the only JavaScript runtime dependencies.

```sh
node dist/cli.js bench setup --benchmark lab
node dist/cli.js bench check --benchmark lab
node dist/cli.js bench tasks --benchmark lab
node dist/cli.js bench split --benchmark lab --seed 42 --split-file .pi2/lab-split.json
node dist/cli.js bench run --benchmark lab --model provider/solver \
  --improver-model provider/improver --k 3 --mode parallel --seed 42 \
  --workers 2 --stage-workers 2 --split train --split-file .pi2/lab-split.json
node dist/cli.js bench judge --experiment /path/printed/by/run --judge-model MODEL
node dist/cli.js bench report --experiment /path/printed/by/run
```

Repeat `bench run` with the same options to resume. Domain streams progress concurrently, but
tasks within each domain are ordered; a failed task stops that domain until resumed. Experiment
identity includes dataset contents, selected tasks, split, seed, model settings, initial harness,
and recursion settings. Judges run separately from refinement. WorkBuddy's verifier runs within
each trial, with only allowlisted agent-authored artifacts exposed as evidence.

Reports preserve missing/failed scores as `null`, show grading coverage, and compare adopted
outputs against the mean of all `k` baselines only on fully scored pairs with matching judges.
Reports include domain totals, all-pass rates, deltas, fallback counts, token usage, and estimated
agent costs (official judge charges are separate). Failed judge calls can be retried; changing the judge model uses separate judge artifacts.

See [official benchmark setup and validation](benchmark/official/README.md) for dependencies,
credentials, WorkBuddy routes, container recovery, and integration checks. These adapters provide
the experiment workflow; they do not establish the paper's empirical gains on Pi models.

## Development

```sh
npm test
```

Tests run real Pi Durable sessions against a local deterministic HTTP model. They cover file
tools, executable plugins, skills/scripts, owned subagents, SQLite reopening, and recovery after
killing a process between tool execution and the next model response. Workflow tests cover both
recursion modes, evidence access, domain separation, resume compatibility, retry/fallback,
cancellation, and symlink isolation. They require local socket access but no credentials or paid
model calls. Benchmark tests cover partitions, concurrent domain streams, resume ordering,
same-domain learning, judge failures and paired reporting. An optional real Harbor/Docker smoke
test validates container tools and a verifier using a local model. They validate mechanics,
not real-model quality improvements.

The method is adapted from Google's [Harness²](https://github.com/google-research/harness2)
(Apache-2.0). The [Pi packages](https://github.com/earendil-works/pi) are MIT-licensed dependencies;
neither repository is vendored.
