# Initial quality benchmark

2026-10-21 · Pi 1.3.0 · `openai/gpt-5.4-mini` · thinking `medium` · Node `v24.19.0`

Both baseline and refined implementations passed **36/36 checks across 3/3 tasks**.
This run showed no quality improvement and no regression. Each task was attempted once.

| Task | Baseline | Refined | Full workflow time | Estimated full cost |
| --- | ---: | ---: | ---: | ---: |
| csv | 12/12 | 12/12 | 90.9 s | $0.2233 |
| intervals | 12/12 | 12/12 | 51.1 s | $0.0868 |
| ledger | 12/12 | 12/12 | 73.2 s | $0.1824 |

| Measurement | Baseline only | Full refinement, including baseline |
| --- | ---: | ---: |
| Tasks fully passed | 3/3 | 3/3 |
| Checks passed | 36/36 | 36/36 |
| Agent sessions | 3 | 24 |
| Assistant messages | 14 | 63 |
| Uncached input tokens | 12152 | 481435 |
| Cached input tokens | 18048 | 66944 |
| Output tokens | 5926 | 28112 |
| Time | 44.7 s | 215.2 s |
| Estimated API cost | $0.0371 | $0.4926 |

The full refinement used about **4.8× the time** and
**13.3× the estimated API cost** of its three baselines.
Baseline timing measures the agent sessions; full workflow timing also includes workspace copying
and orchestration, and excludes external grading and SDK initialization. Prices come from Pi's
model catalog and token usage, not a billing statement. Output tokens include reasoning usage
as reported by Pi.

## Method

Run `npm run bench -- --model openai/gpt-5.4-mini` with provider credentials configured.
This uses one repeat of the `pi2-coding-v1` suite. Baseline and composed execution use the same
model, thinking level, tools, task prompt, and initial stub, each in a fresh workspace.
Every task has isolated learning state. Grades are computed only after refinement and never
sent to the model. All 24 sessions completed successfully; there were no workflow errors.

The [machine-readable report](results/gpt-5.4-mini-2026-10-21.json) includes per-check grades,
per-stage timing, token usage, estimated cost, and source hashes. The run used the working tree
before this benchmark was committed, so its Git metadata records the parent revision and a dirty
working tree; source hashes identify the code that was measured.

## Limits

This small coding suite is not JobBench, LAB, WorkBuddy, or a reproduction of published Harness²
results. All baselines reached the maximum score, leaving no measured headroom for refinement.
One attempt per task cannot establish statistical significance or performance on harder tasks.
Fresh state means this run does not evaluate learning across tasks. Checks are withheld from
prompts but are not protected by an OS sandbox.

Two preliminary runs failed during cloud setup (credential-directory access and Node proxy
configuration), before receiving usable model outputs. They are excluded from the quality
comparison above; their error reports remain in the execution workspace.
