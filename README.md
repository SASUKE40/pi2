# pi2

An implementation of [Harness²](https://github.com/google-research/harness2) on
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

Give it a task and a workspace. pi2 runs the task, proposes harness changes, tests them on fresh
copies, adopts the best result, and records lessons for later tasks. Model weights stay fixed.

## Quick start

Requires Node.js 22.19 or newer.

```sh
npm ci --ignore-scripts
npm run build

export OPENAI_API_KEY=...
npm start -- "Sum every signed amount in ledger.csv and write total.txt." \
  --cwd /path/to/task-files --model openai/gpt-5.4-mini
```

## Usage

```text
pi2 "task" [--cwd DIR] [--model provider/model] [--improver-model provider/model]
           [--thinking LEVEL] [--harness PATH] [--k N] [--mode parallel|sequential]
           [--workers N] [--domain NAME] [--state-dir DIR] [--timeout SECONDS]
pi2 --resume RUN_DIR [--workers N] [--timeout SECONDS]
```

Run `pi2 --help` for defaults. State is stored under `~/.pi2/` and results are never applied to
your original workspace. Interrupted runs continue with `--resume`.

`--harness` takes a Markdown system prompt or a directory:

```text
systemprompt.md
guardrails.md
LongTermMEMORY.md
tool_descriptions/tool_guidance.md
sub_agents/<name>/AGENT.md
skills/<name>/SKILL.md
scripts/<name>.py|sh|js|mjs
plugin/<name>.mjs
```

Plugins and scripts run as local code with your permissions. pi2 is not a sandbox.

## Development

```sh
npm test
```

Tests use a local deterministic model and need no credentials.

## License

Adapted from Google's [Harness²](https://github.com/google-research/harness2) (Apache-2.0).
The [Pi packages](https://github.com/earendil-works/pi) are MIT-licensed dependencies.
