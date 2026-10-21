# pi2

A small, instruction-only implementation of [Harness²](https://github.com/google-research/harness2), built on the [Pi SDK](https://github.com/earendil-works/pi).

Give it a task and a workspace. It runs the task, proposes two instruction changes, probes them, composes a refined harness, and runs that harness. Evidence-supported lessons help refine later tasks in the same workspace.

## Install and run

Requires Node.js 22.19 or newer.

```sh
npm ci --ignore-scripts
npm run build

# Configure Pi once with /login, or use an existing provider API key.
npx --no-install pi

npm start -- "Sum every signed amount in ledger.csv and write total.txt." \
  --cwd /path/to/task-files
```

Pi's existing authentication, custom model definitions, and default model are reused. Credentials are never stored in pi2's configuration. The same selected model and thinking level are used throughout a run. To choose a model explicitly, add `--model provider/model` using an ID configured in Pi.

The compiled CLI is also available as `node dist/cli.js`. After building, `npm link --ignore-scripts` makes the `pi2` command available globally.

```text
pi2 "task" [--cwd DIR] [--model provider/model] [--harness FILE]
           [--state-dir DIR] [--timeout SECONDS]
```

| Option | Default |
| --- | --- |
| `--cwd` | Current directory; source files for every execution |
| `--model` | Pi's configured model, or its first available default |
| `--harness` | Empty; optional initial Markdown instruction file |
| `--state-dir` | `~/.pi2/<hash of canonical workspace path>` |
| `--timeout` | 600 seconds per agent session |

## What happens

1. **Baseline:** run the task with Pi's standard prompt and the initial instructions.
2. **Propose:** independently propose a general improvement and a task-domain improvement from the baseline evidence and earlier lessons.
3. **Probe:** run both candidates on fresh copies of the original input.
4. **Compose:** compare the baseline and probes; combine supported changes or retain the original instructions.
5. **Execute:** run the composed instructions on a fourth fresh copy. This is the returned result.
6. **Reflect:** save a transferable lesson with supporting evidence and the adopted instructions, or save no lesson when the evidence is insufficient.

There are eight agent sessions: four task executions and four improvement calls. Tool use and Pi's automatic recovery can cause multiple model requests per session. Model-backed runs incur the selected provider's API costs.

Task executions use Pi's `read`, `bash`, `edit`, and `write` tools. Improvement sessions have no tools. Automatic extension, skill, and prompt-template loading is disabled. Task sessions retain Pi's context-file discovery, including copied `AGENTS.md` files; custom system-prompt files are overridden so only the supplied instruction block changes between runs.

Editors see traces and responses, not benchmark grades. The last five learning entries guide future editors and composers, without replacing the next task's initial harness. This implements one refinement step and learning across tasks; it does not include upstream benchmark integrations, repeated recursion, or a guarantee that the composed result is better.

## Files and failures

The CLI prints the final answer and its output directory. Run state contains:

```text
state/
  memory.jsonl
  runs/run-…/
    config.json
    status.json
    input/
    baseline/, probe-general/, probe-task/, composed/
      workspace/
      instructions.md, prompt.txt, answer.txt, trace.txt, messages.json
    propose-general/, propose-task/, compose/, reflect/
    result.json
```

The input snapshot includes files and dependency directories, excluding `.git` and the state directory. Internal symlinks are rebased to targets inside each copy, preserving npm executable resolution; external links, cycles, and special files are rejected. Use a self-contained workspace and allow disk space for the snapshot and four execution copies. Dependencies with hard-coded absolute paths may need adjustment inside task copies.

Results are never automatically applied to the source workspace. Copies isolate ordinary file changes between attempts; **they are not a security sandbox**. Pi's Bash tool still has the launching process's filesystem and network access. Run folders retain task data and transcripts.

Malformed editor responses, model errors, timeouts, or Ctrl+C stop the run with a nonzero exit and preserve completed artifacts. Learning is written only after all stages complete successfully. A reflection failure leaves the composed output available in its run folder. `null` reflection is successful and adds no learning entry. Each invocation creates a new run; automatic resume is not implemented.

Use the same state directory to share learning intentionally, or a fresh one to start without prior lessons.

## Quality benchmark

```sh
# Uses your configured Pi model and makes paid model calls.
npm run bench
npm run bench -- --model provider/model --repeats 3
# Start with one task if desired.
npm run bench -- --task csv --timeout 180
```

The small `pi2-coding-v1` suite compares baseline and refined implementations on CSV parsing,
interval merging, and exact ledger reconciliation (12 checks each). Both executions use the
same model, tools, task, and starting files. Every attempt starts with fresh learning state;
this measures refinement on individual tasks, not learning across tasks. The default is one
attempt per task, or 24 agent sessions in total. `--repeats` repeats all selected tasks.

Checks run after the full refinement loop and never enter agent prompts or editor feedback.
They are outside copied workspaces but are not protected by an OS sandbox. Failed workflows
count as failed refined attempts, and reports retain completed baseline grades and errors.
Reports under `.pi2/benchmarks/quality-*/report.json` contain per-check outcomes, paired
improvements/regressions, traces, per-stage timing and token usage, and estimated API costs.
Full workflow cost includes all eight sessions, including the baseline; missing usage is
reported as `null`. Pi's model pricing is an estimate, not a billing receipt.

This is an exploratory coding suite, not JobBench, LAB, WorkBuddy, or a reproduction of the
Harness² paper. A few tasks cannot establish general improvement. No mock model is used for
quality results: missing Pi credentials stop the benchmark before recording scores.

See the [initial GPT-5.4-mini results](benchmark/RESULTS.md) for a recorded live run.

## Development

```sh
npm test
```

Tests cover workspace isolation, cross-task learning, bounded memory retrieval, failure handling, cancellation, and symlinks. SDK integration tests run real Pi sessions and file tools against a local deterministic HTTP model; they need no credentials and make no paid model calls. They validate execution mechanics, not real-model improvement quality.

The method is adapted from Google's [Harness²](https://github.com/google-research/harness2) (Apache-2.0). Pi is [MIT-licensed](https://github.com/earendil-works/pi/blob/main/LICENSE). This implementation uses Pi as a dependency and does not vendor either repository.
