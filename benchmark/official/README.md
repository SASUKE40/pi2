# Official benchmarks on Pi Durable

The bridge pins `google-research/harness2` to
[`1cfe254e8d25b15f37048c3730134686abe60335`](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335).
Its own pinned benchmark revisions and judge patches are installed by `bench setup`.
Benchmark sources retain their licenses, including WorkBuddy's dataset-specific license.
No benchmark source or dataset is vendored in pi2.

## Requirements and setup

Use Node 22.19+, Python 3.12 or 3.13, Git, `uv`, and npm. JobBench and LAB need Pandoc and
Poppler (`pdftotext`) for document extraction. WorkBuddy needs a running Docker daemon and curl;
its task images must provide Python 3 for file tools. Setup downloads benchmark repositories,
Python environments and datasets. Dataset size and container builds can be substantial.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js bench setup --benchmark jb --dry-run
node dist/cli.js bench setup --benchmark jb
node dist/cli.js bench check --benchmark jb
```

Use `--upstream /path/to/harness2` to relocate the pinned checkout (default `~/.pi2/harness2`).
`PI2_PYTHON` chooses the bridge interpreter. A different upstream commit is rejected.
`bench check` reports missing tools, environments, datasets, and WorkBuddy configuration without
calling a paid model. Pi provider credentials are checked before `bench run` starts.

## Task execution and judges

JobBench and LAB run locally in independent workspace copies. Task inputs are staged under
`documents/`, requested deliverables go under `output/`, and `scripts/read_doc.py` invokes the
benchmark environment's binary-document reader. Rubrics and LAB criteria are excluded from
the prepared task data. The official extractor writes `deliverables.txt` for improvement and
selection agents to inspect alongside the actual artifacts.

Configure `HARNESS2_JUDGE_MODEL` (or `--judge-model`) for `bench judge`. JobBench also accepts
`HARNESS2_JUDGE_BASE_URL` / `--judge-base-url` and `HARNESS2_JUDGE_API_KEY`. The upstream default
uses Vertex credentials and `GOOGLE_CLOUD_PROJECT`. LAB uses its upstream LiteLLM/Vertex judge
configuration. See the pinned [upstream benchmark notes](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/BENCHMARKS.md)
for provider-specific details. Solver credentials come independently from pi-ai.

Judges can incur model charges. Grading failure is stored as an unscored result and retried on
the next `bench judge`. Judge model/endpoint changes use a new cache directory. Reports exclude
incomplete baseline sets and mixed-judge pairs from aggregate deltas.

## WorkBuddy

```sh
node dist/cli.js bench setup --benchmark wb-code
node dist/cli.js bench check --benchmark wb-code
node dist/cli.js bench run --benchmark wb-code --model provider/model --k 1 --limit 1
```

Setup registers `workbuddy_bench.agents.pi_agent:PiAgent` as `pi2/1.3.0`. Each solver rollout
uses the real WorkBuddy job runner and a fresh Harbor container. Pi Durable's model calls,
SQLite journal, plugins, and subagent conversations run on the host. Read/write/edit/bash
calls execute as the benchmark's agent user inside the container through an authenticated
loopback RPC channel. Harness skills and scripts are installed at `/workspace/.pi2-harness`.
Provider credentials are not copied into the container. Plugins still execute as host JavaScript;
they are trusted executable harness code, not a container isolation boundary.

WorkBuddy requires its own model route even though Pi's solver uses pi-ai directly. Its proxy
also serves verifier/judge requests. Set:

- `PI2_WB_MODEL`: existing route under `configs/models/`, default `harness2/solver`.
- `PI2_WB_JUDGE`: web judge route, default supplied by upstream (`harness2/judge`).
- `PI2_WB_CONNECTION`: `local_proxy` (default) or `direct`, subject to the subset's verifier requirements.

For the upstream Vertex configuration, set `HARNESS2_SOLVER_MODEL=google-vertex/gemini-...`,
`HARNESS2_JUDGE_MODEL=gemini-...`, and `GOOGLE_CLOUD_PROJECT` before setup. The bridge then
generates upstream's solver/judge route files. Otherwise configure routes using WorkBuddy's
`configs/models/_template.model.yaml`; `bench check` identifies a missing solver route.
Pi's `--model` remains independent of these WorkBuddy route settings.

The catalog passes each adapter's `BenchSpec.leak_globs` and `proposer_deliverables` through to
refinement. Matching paths are stripped from every editor's `context/source/`, and every context is
checked for answer-key paths and grader-verdict markers. For `wb-code`, editors see only the names
of the files a rollout produced, as upstream does. The selector always sees the produced files.
Benchmark guidance is the adapter's full `BenchPrompts` for the task, so the INV/DOM levers, the
yardstick, the selection checks, and the `tts` pack for JobBench match upstream.

Verifier files remain outside all editor evidence directories. The upstream artifact allowlist
admits office raw deliverables, code patches, and web workspace archives. Only these artifacts
are rendered. A missing verifier score is `null`, never an invented zero. `bench judge` reads
the recorded WorkBuddy verifier result; it does not rerun a destroyed container's verifier.

A completed trial is reused on resume. If a process dies before the trial completes, the
next attempt starts a fresh container and archives the old durable journal under `abandoned-*`.
Replaying a journal against an empty container would incorrectly skip committed file writes.
Ordinary local Pi sessions retain their existing durable resume semantics.

## Validation

`npm test` runs offline fixture and local-model tests. After installing the pinned WorkBuddy
Python environment, this optional smoke test runs a real Harbor Docker task with a deterministic
local HTTP model, exercises all four container tools, and checks a file through Harbor's verifier:

```sh
node benchmark/official/smoke.mjs /absolute/path/to/harness2
```

`python3 benchmark/official/verify.py /absolute/path/to/harness2` also checks all five pinned
dataset adapters, rubric stripping, weighted/partial scores, artifact filtering, and symlink
rejection against synthetic dataset fixtures, without installing datasets or calling models.

It uses the `python:3.12-slim` image, makes no paid model calls, and leaves logs in the printed
temporary directory. It is a runtime integration test, not a result on WorkBuddy's official tasks.
No paid JobBench/LAB/WorkBuddy quality sweep has been recorded for this implementation.
