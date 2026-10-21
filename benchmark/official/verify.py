"""Verify the bridge against pinned upstream adapters using small local fixtures.

python3 benchmark/official/verify.py /absolute/path/to/harness2
No datasets are downloaded and no judge/model endpoints are called.
"""
import json
from pathlib import Path
import sys
import tempfile

import bridge

revision = "1cfe254e8d25b15f37048c3730134686abe60335"
cfg = bridge.bootstrap({"upstream": sys.argv[1], "revision": revision, "action": "check"})


def put(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


with tempfile.TemporaryDirectory(prefix="pi2-adapters-") as temp:
    root = Path(temp)
    cfg.DEPENDENCIES = root / "dependencies"
    cfg.RUNS = root / "runs"
    cfg.JB_JUDGE_PYTHON = root / "missing-judge-python"
    cfg.JB_JUDGE_MODEL = "fixture"
    cfg.LAB_PYTHON = root / "missing-lab-python"
    jb = cfg.jb_repo() / "dataset/main/Accounting/task1"
    put(jb / "task_folder/TASK_INSTRUCTIONS.txt", "Write a reconciliation memo.")
    put(jb / "task_folder/ledger.txt", "5 + 7")
    bridge.dump(jb / "RUBRICS.json", {"rubrics": [{"weight": 10, "criterion": ["SECRET_RUBRIC"]}]})
    lab = cfg.lab_repo() / "tasks/contracts/task1"
    bridge.dump(lab / "task.json", {"title": "Review", "work_type": "review", "instructions": "Review the contract.",
                                   "deliverables": {"memo.txt": "advice"}, "criteria": ["SECRET_CRITERIA"]})
    put(lab / "documents/contract.txt", "Term: one year")
    for subset in ("office", "web", "code"):
        task = cfg.wb_repo() / f"datasets/wb-bench-{subset}-v1.0/tasks/task1"
        put(task / "task.toml", '[metadata]\nrole="Engineering"\ncategory="Documents"\n')
        put(task / "instruction.md", "Create the requested artifact.")
        put(task / "tests/hidden.txt", "SECRET_VERIFIER")
        put(task / "solution/answer.txt", "SECRET_ANSWER")
    for bench in ("jb", "lab", "wb-office", "wb-web", "wb-code"):
        req = {"benchmark": bench, "revision": revision}
        a = bridge.adapter(bench)
        catalog = bridge.catalog(req, cfg, a)
        assert len(catalog["tasks"]) == 1
        assert "SECRET" not in json.dumps(catalog)
        task = catalog["tasks"][0]["id"]
        workspace = root / bench / "workspace"
        req.update(task=task, cwd=str(workspace), scoreDir=str(root / bench / "judging"))
        bridge.prepare(req, cfg, a)
        assert not any("SECRET" in p.read_text() for p in workspace.rglob("*") if p.is_file())
        if bench == "jb":
            # Empty delivered output is a real zero using the official rubric weight.
            score = bridge.score(req, cfg, a)
            assert score["n_passed"] == 0 and score["n_criteria"] == 10
            put(workspace / "output/memo.txt", "Reconciled: 12")
            details = root / bench / "judging" / task / "eval_result/eval_pi2/fixture_judge.json"
            bridge.dump(details, {"total_score": 7, "max_score": 10, "rubrics": [{"result": {"criteria_count": 2, "criteria_passed": 1}}]})
            score = bridge.score(req, cfg, a)
            assert score["n_passed"] == 7 and score["n_criteria"] == 10
            bridge.render(req, cfg, a)
            assert "Reconciled: 12" in (workspace / "deliverables.txt").read_text()
        elif bench == "lab":
            put(workspace / "output/memo.txt", "Reviewed")
            bridge.dump(Path(req["scoreDir"]) / "scores.json", {"n_passed": 3, "n_criteria": 4, "all_pass": False})
            score = bridge.score(req, cfg, a)
            assert score["n_passed"] == 3 and score["n_criteria"] == 4
        else:
            trial = root / bench / "trial"
            bridge.dump(workspace.parent / "workbuddy.json", {"trial": str(trial)})
            assert bridge.score(req, cfg, a) is None
            bridge.dump(trial / "verifier/score.json", {"reward": .75, "hidden": "SECRET_SCORE"})
            assert bridge.score(req, cfg, a)["raw_score"] == .75
            if bench == "wb-code":
                put(trial / "verifier/agent.patch", "diff --git a/test.txt b/test.txt\n+agent change\n")
                bridge.render(req, cfg, a)
                assert "agent change" in (workspace / "deliverables.txt").read_text()
                assert "SECRET" not in (workspace / "deliverables.txt").read_text()
    external = root / "external"
    external.write_text("private")
    link = root / "link"
    link.symlink_to(external)
    try:
        bridge.safe_copy(link, root / "copied")
        raise AssertionError("Symlink was copied")
    except ValueError:
        pass
print("Pinned upstream adapter fixtures passed: jb, lab, wb-office, wb-web, wb-code")
