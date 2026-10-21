# Quality benchmarks

## GLM-5.3-Flash hard task set

2026-10-21 · Pi Durable 1.3.0 · `zai-coding-cn/glm-5.3-flash` · thinking `low` · Node `v26.12.0`

**Only 1/3 full refinement workflows completed within budget. No quality gain was demonstrated.**
This run used the local `pi2-hard-v1` suite: 3 tasks, 236 fixed checks, one attempt per task,
fresh state, and a 420-second limit per agent session. Baseline and refinement used the same
model, reasoning level, tools, task prompt, and initial files. Grading never entered feedback.

| Task | Checks | Baseline | Refined delivery | Full attempt time |
| --- | ---: | --- | --- | ---: |
| Minimum-cost flow with negative cycles | 76 | Timed out | Not reached | 420.0 s |
| Canonical three-way merge | 89 | 89/89 | Timed out | 655.2 s |
| Snapshot transactions and savepoints | 71 | 71/71 | 71/71 | 357.4 s |

The low-reasoning run took **1,432.6 seconds (23.9 minutes)** across 18 agent sessions,
including two successful corrective proposal retries. There were no schema fallbacks.
Transactions saved a reflection lesson, but this fresh-state experiment does not test reuse on
later tasks. Its full workflow cost estimate was $0.0374 versus $0.0020 for its baseline, with
357.4 seconds versus 45.7 seconds and no score change.

Timeouts need separate interpretation from correctness. Postmortem grading of the unfinished
flow implementation itself exceeded the grader's five-second limit. The unfinished merge
implementation passed **89/89**, but its agent kept iterating and never completed the session.
The composed merge harness emphasized repeated verification; this observation suggests a
termination/verification-budget problem, rather than a correctness loss on these checks.
The local runner stops a task when an execution fails, so the flow timeout prevented its
refinement. This differs from the failure-tolerant mode used by the official benchmark runner.

The report's delivery totals are baseline 160/236 and refined 71/236 because unfinished
executions count as failures. Its paired comparison contains only the completed transaction
task (one tie); it excludes workflow errors. Neither measure establishes improvement.
Reported low-run usage has a Pi catalog valuation of **$0.0938**, but interrupted generation
usage may be missing, so the full cost is unknown. The BigModel coding-plan endpoint was used;
these USD catalog estimates are not a billing statement or a measure of plan quota consumption.

An earlier high-reasoning calibration timed out on the first baseline after 420 seconds without
producing a solution. The next task was cancelled after 45.8 seconds to stop that configuration.
Those incomplete attempts and their unknown usage are preserved separately, not pooled into
the low-reasoning quality comparison.

```sh
npm run bench -- --model zai-coding-cn/glm-5.3-flash --suite hard --thinking low --repeats 1 --timeout 420
```

The [full low-reasoning report](results/glm-5.3-flash-hard-low-2026-10-21.json) includes source
hashes, per-stage timing/usage, errors, reflection diagnostics, and separate unfinished-artifact
grades. The [high-reasoning timeout report](results/glm-5.3-flash-hard-high-timeout-2026-10-21.json)
preserves the calibration failure. All 48 repository tests passed, including independent flow
oracle checks, merge invariants, transaction edge cases, and grader acceptance/rejection tests.

This is a project-authored stress suite, not JobBench, LAB, WorkBuddy, or a reproduction of
Harness2's published results. Tests are fixed and kept outside task prompts/workspaces, but
the filesystem is not an OS sandbox. One attempt per task provides no statistical estimate of
general model quality. The model identifier and reasoning options were checked against
[GLM's official documentation](https://docs.z.ai/guides/vlm/glm-5.3-flash).

## Pi Durable minimal benchmark

2026-10-21 · Pi Durable 1.3.0 · `xai/grok-4.3` · thinking `medium` · Node `v26.12.0`

The current runtime completed one ledger-reconciliation task using the lowest-cost model
available with the configured credentials. Both baseline and refined solutions passed **12/12
checks**. This verifies real-model execution on this task; it shows no quality improvement or
regression and does not validate the official Harness2 benchmarks.

| Measurement | Baseline only | Full refinement, including baseline |
| --- | ---: | ---: |
| Checks passed | 12/12 | 12/12 |
| Agent sessions | 1 | 9 |
| Time | 40.3 s | 218.9 s |
| Estimated API cost | $0.0181 | $0.2790 |

The full workflow used about **5.4× the time** and **15.4× the estimated cost** of the baseline.
All sessions completed without transport errors. General improvement retained the original
harness; task-specific improvement added exact-arithmetic and revision-selection guidance,
which composition retained. Reflection returned `{"lesson": null, "evidence": ""}` twice instead
of the required top-level `null`. The documented fallback preserved the final solution and
saved no lesson. The ninth session was this corrective reflection retry; its cost is included.

```sh
npm run bench -- --model xai/grok-4.3 --task ledger --repeats 1 --timeout 180
```

The [machine-readable report](results/grok-4.3-durable-ledger-2026-10-21.json) includes grades,
per-stage usage and timing, reflection diagnostics, and hashes of the measured sources.
This used the three requested Pi packages and no coding-agent dependency. Baseline and final
execution received the same task, model, and initial stub in separate workspaces. Grades ran
after refinement and were never supplied as editor feedback. Checks cover exact decimal sums,
large integers, signed amounts, revisions, ties, status changes, currencies, and empty input.

This is one attempt on one task from the local `pi2-coding-v1` suite. The perfect baseline leaves
no measured headroom, and fresh state does not test learning across tasks. Checks are withheld
from prompts but not protected by an OS sandbox. Costs are Pi catalog estimates, not billing
statements; wall time includes orchestration and excludes external grading and SDK initialization.

## Historical initial quality benchmark

Historical result from the earlier `pi-coding-agent` implementation. These measurements do not
validate the current Pi Durable runtime.

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
