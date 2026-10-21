# pi2

An implementation of [Harness²](https://github.com/google-research/harness2) on
[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

You give pi2 a task and a workspace. pi2 does the task and proposes changes to the harness. It tests
each change on a new copy of the workspace. Then it keeps the best result and records lessons for
the next tasks. pi2 does not change the model weights.

## Quick start

You must have Node.js 22.19 or newer.

```sh
npm ci --ignore-scripts
npm run build

export OPENAI_API_KEY=...
npm start -- "Write fizzbuzz.mjs. It prints FizzBuzz for the numbers 1 to 100."
```

pi2 works in a copy of this repository and writes no files here. pi2 uses the first model that has
credentials. To use a different model, set `PI2_MODEL` or `--model provider/model`.

## Usage

```text
pi2 "task" [--cwd DIR] [--model provider/model] [--improver-model provider/model]
           [--thinking LEVEL] [--harness PATH] [--k N] [--mode parallel|sequential]
           [--workers N] [--domain NAME] [--state-dir DIR] [--timeout SECONDS]
pi2 --resume RUN_DIR [--workers N] [--timeout SECONDS]
```

To see the default values, run `pi2 --help`.

pi2 keeps its state in `~/.pi2/`. pi2 does not apply results to your original workspace. To
continue a run that stopped, use `--resume`.

`--harness` accepts a Markdown system prompt or a directory:

```text
systemprompt.md
guardrails.md
LongTermMEMORY.md
tool_descriptions/tool_guidance.md
sub_agents/<name>/AGENT.md
skills/<name>/SKILL.md
scripts/<name>.mjs
plugin/<name>.mjs
```

WARNING: Plugins and scripts run as local code with your permissions. pi2 is not a sandbox.

## Development

```sh
npm test
```

The tests use a local deterministic model. They do not need credentials.

## License

pi2 is adapted from Google's [Harness²](https://github.com/google-research/harness2) (Apache-2.0).
The [Pi packages](https://github.com/earendil-works/pi) are dependencies with the MIT license.
