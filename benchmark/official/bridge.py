#!/usr/bin/env python3
"""Pinned upstream data/readers/judges; all agent execution belongs to Pi Durable.

The JSON file protocol keeps upstream diagnostic stdout out of structured responses.
No evaluation output is copied into an agent workspace.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
NAMES = {"jb": "job-bench-eval", "lab": "harvey-labs", "wb": "workbuddy-bench"}


def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".pending")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    tmp.replace(path)


def run(argv, **kwargs):
    return subprocess.run([str(x) for x in argv], check=True, **kwargs)


def bootstrap(req):
    root = Path(req["upstream"])
    if not root.exists():
        if req["action"] != "setup":
            raise RuntimeError(f"Missing {root}; run pi2 bench setup first")
        root.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "init", "-q", root])
        run(["git", "-C", root, "remote", "add", "origin", "https://github.com/google-research/harness2.git"])
        run(["git", "-C", root, "fetch", "--depth", "1", "origin", req["revision"]])
        run(["git", "-C", root, "checkout", "--detach", "FETCH_HEAD"])
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != req["revision"]:
        raise RuntimeError(f"Harness2 revision mismatch: {head}; expected {req['revision']}")
    sys.path.insert(0, str(root))
    from harness2 import config
    return config


def install_workbuddy(cfg):
    repo = cfg.wb_repo()
    shutil.copy2(HERE / "pi_agent.py", repo / "src/workbuddy_bench/agents/pi_agent.py")
    harness = repo / "configs/harnesses/pi2"
    dump(harness / "_defaults.yaml", {"harness": {"name": "pi2", "import_path": "workbuddy_bench.agents.pi_agent:PiAgent", "protocol": "openai"}})
    dump(harness / "versions/1.3.0.yaml", {"harness": {"params": {}}})
    registry = repo / "src/workbuddy_bench/runner/harness_adapters.py"
    body = registry.read_text()
    if '"pi2": HarnessRuntimeAdapter(' not in body:
        anchor = "HARNESS_ADAPTERS: dict[str, HarnessRuntimeAdapter] = {"
        if anchor not in body:
            raise RuntimeError("Unsupported WorkBuddy harness registry")
        body = body.replace(anchor, anchor + '''
    "pi2": HarnessRuntimeAdapter(
        harness_name="pi2", canonical_display_name="Pi Durable",
        harness_protocol="openai", backend_base_env="PI2_BENCH_BASE_URL",
        backend_key_env="PI2_BENCH_API_KEY", proxy_url_env="",
        uses_anthropic_env=False,
    ),''', 1)
        registry.write_text(body)


def adapter(bench):
    if bench == "jb":
        from harness2.benchmarks.jobbench import JobBenchAdapter
        return JobBenchAdapter()
    if bench == "lab":
        from harness2.benchmarks.lab import LabAdapter
        return LabAdapter()
    from harness2.benchmarks.workbuddy import WbAdapter
    return WbAdapter(subset=bench.split("-", 1)[1])


def safe_copy(src, dst):
    """Never follow links from a dataset or an agent output into grader/host files."""
    src, dst = Path(src), Path(dst)
    if src.is_symlink():
        raise ValueError(f"Refusing symlink in benchmark data/artifacts: {src}")
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        for p in sorted(src.iterdir()):
            if p.name != ".git":
                safe_copy(p, dst / p.name)
    elif src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    elif src.exists():
        raise ValueError(f"Not a regular artifact: {src}")


def setup(req, cfg):
    from harness2 import install
    bench = req["benchmark"].split("-", 1)[0]
    name = NAMES[bench]
    dry = req.get("dryRun", False)
    install.clone(name, dry_run=dry)
    install.patch(name, dry_run=dry)
    install.overlays(name, dry_run=dry)
    repo = cfg.DEPENDENCIES / name
    install.run(["uv", "sync", "--locked", "--python", "3.12"], cwd=repo, dry_run=dry)
    packages = ["python-docx"] if bench == "jb" else ["google-auth[requests]"] if bench == "lab" else ["openpyxl>=3.1,<4", "python-pptx>=1,<2"]
    install.run(["uv", "pip", "install", "--python", repo / ".venv/bin/python", *packages], dry_run=dry)
    if bench == "jb":
        install.download_jobbench(dry_run=dry)
    if bench == "wb":
        install.run(["bash", "scripts/dataset/fetch-dataset.sh", req["benchmark"].split("-", 1)[1]], cwd=repo, dry_run=dry)
        if not dry:
            install_workbuddy(cfg)
            if cfg.SOLVER_MODEL_OC.startswith("google-vertex/gemini") and cfg.JUDGE_MODEL.startswith("gemini") and cfg.VERTEX_PROJECT:
                install.workbuddy_models()
    return {"installed": not dry, "benchmark": req["benchmark"], "upstream": str(cfg.ROOT)}


def check(req, cfg):
    bench = req["benchmark"].split("-", 1)[0]
    repo = cfg.DEPENDENCIES / NAMES[bench]
    checks = {"python": sys.version_info >= (3, 12), "judge_environment": (repo / ".venv/bin/python").is_file()}
    for cmd in (["docker", "uv"] if bench == "wb" else ["pandoc", "pdftotext"]):
        checks[cmd] = shutil.which(cmd) is not None
    if bench == "wb" and checks["docker"]:
        checks["docker_daemon"] = subprocess.run(["docker", "info"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        checks["pi_agent"] = (repo / "src/workbuddy_bench/agents/pi_agent.py").is_file()
        checks["workbuddy_model_config"] = (repo / "configs/models" / (os.environ.get("PI2_WB_MODEL", "harness2/solver") + ".yaml")).is_file()
    try:
        count = len(adapter(req["benchmark"]).tasks())
        checks["dataset"] = count > 0
    except (FileNotFoundError, ValueError):
        checks["dataset"] = False
        count = 0
    return {"ok": all(checks.values()), "checks": checks, "tasks": count}


def catalog(req, cfg, a):
    tasks = []
    spec = {"leakGlobs": list(a.spec.leak_globs), "deliverables": a.spec.proposer_deliverables}
    for task_id in a.tasks():
        prompt = a.task_prompt(task_id)
        if req["benchmark"] in ("jb", "lab"):
            prompt += "\n\nInput files are in documents/. Save every requested deliverable in output/. Use python3 scripts/read_doc.py PATH to read PDF, DOCX, XLSX and PPTX inputs."
        tasks.append({"id": task_id, "domain": a.domain_of(task_id), "prompt": prompt,
                      "guidance": json.dumps(dataclasses.asdict(a.prompts_for(task_id))), **spec})
    # Hash actual installed input bytes, including the recorded HF revision, so a changed
    # dataset cannot silently reuse an earlier experiment/library namespace.
    bench = req["benchmark"].split("-", 1)[0]
    repo = cfg.DEPENDENCIES / NAMES[bench]
    data = repo / "dataset/main" if bench == "jb" else repo / "tasks" if bench == "lab" else a.subset_info.tasks_dir
    digest = hashlib.sha256(req["revision"].encode())
    if bench == "wb":
        for route in (os.environ.get("PI2_WB_MODEL", "harness2/solver"), os.environ.get("PI2_WB_JUDGE", "harness2/judge")):
            digest.update(route.encode())
            path = cfg.wb_repo() / "configs/models" / (route + ".yaml")
            if path.is_file():
                digest.update(path.read_bytes())
        digest.update(os.environ.get("PI2_WB_CONNECTION", "local_proxy").encode())
    for path in sorted(data.rglob("*")):
        if path.is_file() and not path.is_symlink():
            digest.update(str(path.relative_to(data)).encode())
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
    return {"benchmark": req["benchmark"], "revision": digest.hexdigest(), "tasks": tasks}


def prepare(req, cfg, a):
    cwd = Path(req["cwd"])
    if cwd.is_dir():
        return {"cwd": str(cwd)}
    cwd.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cwd.parent) as temp:
        staged = Path(temp) / "input"
        staged.mkdir()
        bench = req["benchmark"]
        if bench in ("jb", "lab"):
            (staged / "documents").mkdir()
            source = a.task_files(req["task"])
            if source is not None:
                safe_copy(source, staged / "documents")
            (staged / "output").mkdir()
            script = cfg.ROOT / "third_party/lab_runner/opencode/scripts/read_doc.py"
            safe_copy(script, staged / "scripts/read_doc.py")
            # Use the benchmark environment's installed binary readers.
            python = cfg.JB_JUDGE_PYTHON if bench == "jb" else cfg.LAB_PYTHON
            (staged / "scripts/read_doc.py").write_text(
                f"import os, sys\nos.execv({str(python)!r}, [{str(python)!r}, {str(script)!r}, *sys.argv[1:]])\n")
        else:
            # Container setup, solutions and tests never enter improver evidence.
            (staged / "instruction.md").write_text(a.task_prompt(req["task"]))
        staged.rename(cwd)
    return {"cwd": str(cwd)}


def render(req, cfg, a):
    cwd = Path(req["cwd"])
    if req["benchmark"] == "jb":
        body = a.deliverable_text(cwd / "output")
    elif req["benchmark"] == "lab":
        body = a.deliverable_text(cwd)
    else:
        from harness2.benchmarks import wb_render
        cfg.WB_RENDER_PY = str(cfg.wb_repo() / ".venv/bin/python")
        trial = json.loads((cwd.parent / "workbuddy.json").read_text())["trial"]
        body = wb_render.flat_text(Path(trial), a.subset)
        if a.subset == "office":
            for name, path in wb_render.raw_files(Path(trial), a.subset):
                target = cwd / "output" / name
                if not target.resolve().is_relative_to((cwd / "output").resolve()):
                    raise ValueError("Artifact path escapes output")
                safe_copy(path, target)
    (cwd / "deliverables.txt").write_text(body)
    return {"rendered": True}


def score(req, cfg, a):
    cwd, dest = Path(req["cwd"]), Path(req["scoreDir"])
    dest.mkdir(parents=True, exist_ok=True)
    if req["benchmark"] == "jb":
        from harness2.benchmarks.jobbench import JobBenchAdapter
        a = JobBenchAdapter(store_root=dest)
        output = dest / req["task"] / "model_output/pi2"
        safe_copy(cwd / "output", output)
        return a.score(output, req["task"])
    if req["benchmark"] == "lab":
        safe_copy(cwd / "output", dest / "output")
        return a.score(dest, req["task"])
    from harness2.benchmarks.workbuddy import score_from_payload
    trial = Path(json.loads((cwd.parent / "workbuddy.json").read_text())["trial"])
    path = trial / "verifier/score.json"
    if not path.is_file():
        return None
    value = score_from_payload(json.loads(path.read_text()))
    return None if value is None else {"n_passed": value * 100, "n_criteria": 100, "all_pass": value >= 1, "raw_score": value}


def execute(req, cfg, a):
    """Use the real WorkBuddy job runner and verifier with our host-side Pi agent."""
    repo = cfg.wb_repo()
    request = req["request"]
    stage = Path(request["artifactDir"])
    response_path = stage / "workbuddy-response.json"
    # A surviving completed trial can be reused after the outer process was interrupted.
    marker = stage / "workbuddy.json"
    if marker.is_file() and response_path.is_file():
        return json.loads(response_path.read_text())
    existing = sorted((stage / "harbor").glob("*/*/result.json"))
    if len(existing) == 1 and response_path.is_file():
        dump(marker, {"trial": str(existing[0].parent)})
        return json.loads(response_path.read_text())
    # A journal cannot be replayed against a newly created, empty container. Retain
    # abandoned attempts for audit/costs and start a new journal with the fresh trial.
    if (stage / "session.sqlite").exists() or (stage / "harbor").exists():
        archive = stage / ("abandoned-" + uuid.uuid4().hex)
        archive.mkdir()
        for name in ("harbor", "session.sqlite", "session.sqlite-wal", "session.sqlite-shm", "usage.json", "messages.json", "workbuddy-response.json"):
            if (stage / name).exists():
                (stage / name).rename(archive / name)
    worker_request = {**request, "model": req["model"], "thinkingLevel": req.get("thinkingLevel", "medium")}
    dump(stage / "workbuddy-request.json", worker_request)
    slug = "pi2-" + uuid.uuid4().hex
    job_path = repo / "configs/jobs" / (slug + ".yaml")
    job = {
        "model": os.environ.get("PI2_WB_MODEL", "harness2/solver"), "harness": "pi2/1.3.0",
        "dataset": f"datasets/{a.subset_info.dataset_id}/tasks", "harness_backend": "local",
        "model_connection": os.environ.get("PI2_WB_CONNECTION", "local_proxy"), "n_attempts": 1,
        "jobs_dir": str(stage / "harbor"), "task_selection": {"mode": "name", "names": [req["task"]]},
        "orchestrator_override": {"n_concurrent_trials": 1},
        "environment_override": {"delete": True},
        "harness_params_override": {"PI2_REQUEST": str(stage / "workbuddy-request.json"), "PI2_RESPONSE": str(response_path),
                                    "PI2_NODE": req["node"], "PI2_WORKER": req["worker"], "PI2_TIMEOUT": req["timeout"]},
    }
    if a.subset_info.llm_judge_model:
        job["llm_judge_override"] = {"model": os.environ.get("PI2_WB_JUDGE", a.subset_info.llm_judge_model)}
    dump(job_path, job)
    try:
        with (stage / "workbuddy.log").open("w") as log:
            subprocess.run(["uv", "run", "--no-sync", "./scripts/run.sh", "--job", slug], cwd=repo,
                           env={**os.environ, "NO_FORCE_BUILD": "1", "HARNESS2_WB_VERTEX_URL": cfg.VERTEX_OPENAI_URL + "/chat/completions"},
                           stdout=log, stderr=subprocess.STDOUT, check=False)
        trials = sorted((stage / "harbor").glob("*/*/agent"))
        trials = [p.parent for p in trials if (p.parent / "config.json").is_file() or (p.parent / "result.json").is_file()]
        if len(trials) != 1 or not response_path.is_file():
            raise RuntimeError(f"WorkBuddy did not complete a Pi rollout; see {stage / 'workbuddy.log'}")
        dump(marker, {"trial": str(trials[0])})
        return json.loads(response_path.read_text())
    finally:
        job_path.unlink(missing_ok=True)


def main(req):
    if req["action"] == "setup" and req.get("dryRun") and not Path(req["upstream"]).exists():
        return {"installed": False, "plan": f"Fetch google-research/harness2 at {req['revision']} into {req['upstream']}; install pinned {req['benchmark']} dependencies, patches, data and Pi adapter. No executor CLI is installed."}
    cfg = bootstrap(req)
    if req["action"] == "setup":
        return setup(req, cfg)
    if req["action"] == "check":
        return check(req, cfg)
    if req["action"] == "judge-info":
        if req["benchmark"].startswith("wb-"):
            # These scores are produced during the trial, so their provenance lives
            # in each WorkBuddy manifest, not today's judge environment variables.
            return {"kind": "workbuddy-trial-verifier", "revision": req["revision"]}
        if not cfg.JUDGE_MODEL:
            raise RuntimeError("Set HARNESS2_JUDGE_MODEL or --judge-model before judging")
        return {"model": cfg.JUDGE_MODEL, "base_url": cfg.JB_JUDGE_API_BASE if req["benchmark"] == "jb" else "", "revision": req["revision"]}
    a = adapter(req["benchmark"])
    if req.get("task") and req["task"] not in a.tasks():
        raise ValueError("Unknown task ID")
    return globals()[req["action"]](req, cfg, a)


if __name__ == "__main__":
    dump(sys.argv[2], main(json.loads(Path(sys.argv[1]).read_text())))
