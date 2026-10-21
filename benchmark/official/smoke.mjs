// Optional integration check: real pinned Harbor + Docker, deterministic local model.
// node benchmark/official/smoke.mjs /absolute/path/to/harness2
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const upstream = resolve(process.argv[2]);
const repo = join(upstream, "dependencies/workbuddy-bench");
const root = await mkdtemp(join(tmpdir(), "pi2-harbor-smoke-"));
const agentFile = fileURLToPath(new URL("pi_agent.py", import.meta.url));
const worker = fileURLToPath(new URL("../../dist/worker.js", import.meta.url));
const stages = [
  ["write", { path: "result.txt", content: "first" }],
  ["edit", { path: "result.txt", oldText: "first", newText: "verified" }],
  ["read", { path: "result.txt" }],
  ["bash", { command: "test \"$(cat /workspace/result.txt)\" = verified && echo tool-ok" }],
];
let requests = 0;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw), n = body.messages.filter(m => m.role === "tool").length;
  requests++;
  const delta = n < stages.length ? { tool_calls: [{ index: 0, id: `tool-${n}`, type: "function", function: { name: stages[n][0], arguments: JSON.stringify(stages[n][1]) } }] } : { content: "Verified container artifact." };
  const event = (d, finish) => `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(event({ role: "assistant", ...delta }, null) + event({}, n < stages.length ? "tool_calls" : "stop") + "data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const modelFile = join(root, "models.mjs");
  await writeFile(modelFile, `import { createModels, createProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { openAICompletionsApi } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/api/openai-completions.lazy"))};
export default () => { const models = createModels(); models.setProvider(createProvider({ id:'smoke', baseUrl:${JSON.stringify(baseUrl)},
models:[{id:'smoke',provider:'smoke',name:'Smoke',api:'openai-completions',baseUrl:${JSON.stringify(baseUrl)},reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
auth:{apiKey:{name:'smoke',resolve:async()=>({auth:{apiKey:'local'}})}},api:openAICompletionsApi() })); return models; };`);
  const task = join(root, "task"), workspace = join(root, "stage/workspace");
  await mkdir(join(task, "environment"), { recursive: true }); await mkdir(join(task, "tests")); await mkdir(workspace, { recursive: true });
  await writeFile(join(task, "instruction.md"), "Write verified to /workspace/result.txt, read it and check with bash.");
  await writeFile(join(task, "task.toml"), 'version = "1.0"\n[agent]\ntimeout_sec = 60\n[environment]\nbuild_timeout_sec = 120\n[verifier]\ntimeout_sec = 30\n');
  await writeFile(join(task, "environment/Dockerfile"), "FROM python:3.12-slim\nWORKDIR /workspace\nRUN mkdir -p /logs/verifier /logs/agent\n");
  await writeFile(join(task, "tests/test.sh"), '#!/bin/bash\nset -eu\ntest "$(cat /workspace/result.txt)" = verified\necho 1 > /logs/verifier/reward.txt\n');
  const request = join(root, "request.json"), response = join(root, "response.json");
  await writeFile(request, JSON.stringify({ stage: "smoke", artifactDir: join(root, "stage"), cwd: workspace, model: "smoke/smoke", tools: true, instructions: "", harness: {} }));
  const py = `import asyncio, json, pathlib, sys, importlib.util
spec=importlib.util.spec_from_file_location('pi_smoke_agent',sys.argv[1]); module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; spec.loader.exec_module(module)
from harbor.models.job.config import JobConfig
from harbor.job import Job
async def main():
    cfg=JobConfig.model_validate(json.loads(pathlib.Path(sys.argv[2]).read_text()))
    job=await Job.create(cfg)
    result=await job.run()
    pathlib.Path(sys.argv[3]).write_text(result.model_dump_json())
asyncio.run(main())
`;
  const config = { job_name: "smoke", jobs_dir: join(root, "jobs"), n_concurrent_trials: 1, tasks: [{ path: task }],
    agents: [{ import_path: "pi_smoke_agent:PiAgent", model_name: "smoke/smoke", kwargs: { PI2_REQUEST: request, PI2_RESPONSE: response, PI2_NODE: process.execPath, PI2_WORKER: worker, PI2_TIMEOUT: 60 } }],
    environment: { type: "docker", delete: true, force_build: false } };
  await writeFile(join(root, "job.json"), JSON.stringify(config));
  const child = spawn(join(repo, ".venv/bin/python"), ["-c", py, agentFile, join(root, "job.json"), join(root, "job-result.json")], { cwd: repo, env: { ...process.env, PI2_MODELS_MODULE: modelFile }, stdio: "inherit" });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const responseValue = JSON.parse(await readFile(response, "utf8"));
  assert.match(responseValue.text, /Verified/);
  assert.equal(requests, 5);
  const job = JSON.parse(await readFile(join(root, "job-result.json"), "utf8"));
  assert.equal(job.stats.n_completed_trials, 1);
  assert.equal(job.stats.n_errored_trials, 0);
  assert.equal(Object.values(job.stats.evals)[0].metrics[0].mean, 1);
  console.log(`Harbor Docker smoke passed: ${root}`);
} finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
