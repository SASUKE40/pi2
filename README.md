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

`--harness` accepts a Markdown file (the initial system prompt) or a directory laid out as the
paper's component tree (Table 5):

```text
systemprompt.md                      # C1, always on
guardrails.md                        # C2, always on; prompt constraints, not an OS policy
LongTermMEMORY.md                    # C3, always on
tool_descriptions/tool_guidance.md   # C4, always on
sub_agents/<name>/AGENT.md           # C5, frontmatter `description:` required
skills/<name>/SKILL.md               # C6, frontmatter `description:` required
skills/<name>/scripts/<file>         #     helpers that travel with their skill
scripts/<name>.py|sh|js|mjs          # C7
plugin/<name>.mjs                    # C8
```

Component names use lowercase letters, digits, `_`, and `-`. Each file is limited to 64,000
characters, the tree to 256,000, and the four always-on files together to 24,000. The tree is
mounted at `.pi2-harness/` in every execution copy, replacing any `.pi2-harness/` the workspace
already had. The always-on files form the solver's instructions, followed by every skill's name
and description, the harness scripts, and the subagents; the agent opens a skill body with `read`
and runs scripts with `bash`.

Each subagent is invoked with `subagent({name, task})`. It runs in its own conversation, owned by
the tool task, in the same workspace, with the solver model and the `read`, `write`, `edit`, and
`bash` tools. It sees only its AGENT.md body and the task, not the caller's conversation or
always-on harness, and it cannot delegate further.

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

Both modes start with `k` base rollouts of the initial harness.

- **Parallel:** `k` INV editors (how the agent works) and `k` DOM editors (what a practitioner
  knows) each edit the base harness from the base rollouts; every candidate is rolled out once;
  then `k` independent aggregators compose finals from the base set and all `2k` candidates.
- **Sequential:** `k` rounds of one INV and one DOM edit of the current checkpoint, both probed,
  then a composition into checkpoint `t`. Later rounds see every earlier candidate and
  checkpoint rollout. The `k` checkpoints are the finals.

The stage prompts are ported from Harness² `core/prompts.py`, both the `adapt` and `tts` packs.
Benchmark text enters only through BenchPrompts values (`work`, `domain_word`, `inv_levers`,
`dom_levers`, `yardstick`, `deliverable_word`, `domain_guidance`, `selection_*`, `prompt_pack`).
Plain-text guidance becomes the domain lens.

Editors work the way upstream's do. Their evidence is a `context/` directory, and the harness is
edited in place in `context/harness/`. Untouched files are inherited, and deleting a file removes
that component. The reply is one `<notes>` block, and `KEEP_BASE` is a valid answer. The evidence
holds the task, source files, complete trajectories, and the files each rollout produced (or only
their names, for benchmarks that withhold contents). Candidates sit in `pool/<label>/` with their
harness, diff, rollout, and products. Earlier stage decisions are included, and so is the
domain library. Before any rollout, a tree must pass validation:

- it stays on the surface above, and the always-on files fit their cap;
- every skill and subagent has a description;
- any script it names exists;
- scripts and plugins parse;
- no grader marker appears.

A rejected tree is returned once, with the reason and the tree left on disk. If it fails again,
the stage keeps its starting harness and records `<stage>-fallback.json`.

The selector sees only the finals that delivered something, shuffled and labelled A, B, …. Its
evidence is the request, the source, and each candidate's answer and files, and it replies with
`<why>` and a ```` ```choice ```` block. An invalid reply gets one retry and then falls back to
the first final in stage order. At `k=1` the single delivered final is adopted without a
selector. If no final delivered, a delivered base rollout is adopted, and `selection.json`
records that.

Reflection sees the adopted harness, the base harness, every candidate with its diff and rollout,
the decisions, and `adoption.json`. It writes one row per edit (`helped`, `hurt`,
`no observed effect`, or `confounded`) to `edits.md`. It then writes one `<experience>` entry
(cue, lesson, evidence, confidence) or `NO_ENTRY`. An unparseable reflection gets one retry and
then saves nothing.

A run makes `4k` executions and `3k` editing sessions, plus reflection, and adds a selector when `k>1`.
A failed execution is recorded as evidence, rather than stopping the run, and is replayed as
failed on resume. Pass `tolerateExecutionFailures: false` to stop on the first failure instead.
The run stops only if no base rollout delivers. Editor, selector, and reflection transport
failures stop the workflow and can be resumed.

Task sessions use Pi Durable's `read`, `bash`, `edit`, and `write` tools plus harness extensions.
Improvement sessions get `ls` and `read` confined to `context/`. Editors additionally get
`write`, `edit`, and `delete`, confined to `context/harness/` after symlink resolution. Paths
matching the adapter's leak globs are removed from `context/source/`. Every context is checked
for answer-key paths and grader-verdict markers before a session starts. These restrictions are
not an OS sandbox for solver tools or executable plugins.

Learning libraries are separated by domain, solver, improver, thinking level, mode, and budget.
Each entry stores the full adopted harness, why it was chosen, its edit rows, and the experience.
Editors browse `context/library/INDEX.md`, then open `harnesses/<run>/harness/` and
`EXPERIENCE.md`. Learning guides editors and does not silently replace the next task's initial
harness. One process at a time owns a state directory; Chord's process lock prevents concurrent
writers.

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
    harnesses/run-…/harness/, EXPERIENCE.md
  runs/run-…/
    config.json, status.json, memory-snapshot.json
    input/
    baseline/, probe-inv/, probe-dom/, composed/       # numbered when k > 1
      workspace/, session.sqlite, failure.json (if it failed)
      request.json, response.json, status.json
      instructions.md, prompt.txt, answer.txt, trace.txt, messages.json, usage.json
    propose-inv/, propose-dom/, compose/              # numbered when k > 1; -retry on rejection
      workspace/context/  harness.json
    select/, reflect/
    selection.json, edits.md, *-fallback.json, result.json
```

The input snapshot includes dependency directories and excludes `.git` and the state directory.
Internal symlinks are rebased; external links, cycles, and special files are rejected. Use a
self-contained workspace and allow space for `4k` execution copies plus the input snapshot.
Outputs are never automatically applied to the original workspace.

Ctrl+C or a timeout closes active durable sessions and preserves pending work for `--resume`.
Resume uses the saved input and learning snapshots. Changes to task, initial harness, model,
thinking level, domain, budget, or mode are rejected. Worker count and timeout may change.
Run directories from earlier pi2 formats cannot be resumed and say so; start a new run. Earlier
libraries are left in place but are not imported, because their entries lack full adopted trees.
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
Failed workflows count as failed refined attempts. A failed probe or final is recorded as evidence
and the workflow continues, but a baseline that delivers nothing stops refinement of that task;
inspect stage status separately from check scores. The refined grade is taken from the adopted
stage. Usage includes subagents and compaction through the durable session ledger; missing
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
