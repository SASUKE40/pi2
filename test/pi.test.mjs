import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiAgent } from "../dist/pi.js";
import { runRefinement } from "../dist/core.js";

function send(res, delta, finish = "stop") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (value, reason) => `data: ${JSON.stringify({
    id: "local-test", object: "chat.completion.chunk", created: 1, model: "test-model",
    choices: [{ index: 0, delta: value, finish_reason: reason }],
  })}\n\n`;
  res.write(chunk({ role: "assistant", ...delta }, null));
  res.write(chunk({}, finish));
  res.end("data: [DONE]\n\n");
}

async function localProvider(t, handle) {
  const root = await mkdtemp(join(tmpdir(), "pi2-sdk-"));
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      await handle(JSON.parse(body), res);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("local-test", {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    api: "openai-completions", apiKey: "local-test-only",
    models: [{
      id: "test-model", name: "Local deterministic test model", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  return { root, runtime };
}

test("real Pi SDK sessions execute file tools through the complete refinement loop", { timeout: 20000 }, async (t) => {
  const requests = [];
  const { root, runtime } = await localProvider(t, (body, res) => {
    requests.push(body);
    const content = body.messages.find((message) => message.role === "user")?.content;
    const prompt = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
    if (!body.tools?.length) {
      const value = prompt.startsWith("The composed execution")
        ? { lesson: "Write a verifiable artifact", evidence: "The composed execution wrote result.txt and confirmed it with read" }
        : { instructions: "Write result.txt and read it back to verify the result.", rationale: "The task requires a file artifact." };
      return send(res, { content: JSON.stringify(value) });
    }
    const toolReplies = body.messages.filter((message) => message.role === "tool");
    if (toolReplies.length < 2) {
      const name = toolReplies.length === 0 ? "write" : "read";
      const args = name === "write" ? { path: "result.txt", content: "verified output" } : { path: "result.txt" };
      return send(res, { tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    }
    return send(res, { content: `Verified: ${toolReplies[1].content}` });
  });
  const cwd = join(root, "input");
  await mkdir(cwd);
  const agent = await createPiAgent({ cwd, model: "local-test/test-model", modelRuntime: runtime });
  const result = await runRefinement({
    task: "Write verified output to result.txt and read it back.", cwd,
    stateDir: join(root, "state"), model: agent.model, timeoutMs: 10000,
  }, agent.call);
  assert.equal(await readFile(join(result.outputDir, "result.txt"), "utf8"), "verified output");
  await assert.rejects(readFile(join(cwd, "result.txt")), { code: "ENOENT" });
  assert.match(result.answer, /verified output/);
  assert.equal(result.learned, true);
  assert.equal(requests.filter((request) => !request.tools?.length).length, 4);
  assert.equal(requests.filter((request) => request.tools?.length).length, 12);
  for (const request of requests.filter((request) => request.tools?.length)) {
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["bash", "edit", "read", "write"]);
  }
  const messages = JSON.parse(await readFile(join(result.runDir, "composed", "messages.json"), "utf8"));
  assert.equal(messages.filter((message) => message.role === "toolResult").length, 2);
  assert.ok(messages.some((message) => message.role === "toolResult" && message.toolName === "read" && !message.isError));

  // Exercise the actual CLI, loading the local provider through Pi's models.json.
  const agentDir = join(root, "pi-config");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "local-test": runtime.getRegisteredProviderConfig("local-test"),
  } }));
  const child = spawn(process.execPath, [
    "dist/cli.js", "Write verified output to result.txt and read it back.", "--cwd", cwd,
    "--model", "local-test/test-model", "--state-dir", join(root, "cli-state"), "--timeout", "10",
  ], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => child.kill());
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.match(stdout, /verified output/);
  assert.match(stdout, /Lesson saved: yes/);
  const output = /^Output: (.+)$/m.exec(stdout)?.[1];
  assert.ok(output, stdout);
  assert.equal(await readFile(join(output, "result.txt"), "utf8"), "verified output");
  await assert.rejects(readFile(join(cwd, "result.txt")), { code: "ENOENT" });

  // Validate reporting with a scripted model; these are runner checks, not quality results.
  const bench = spawn(process.execPath, [
    "benchmark/run.mjs", "--model", "local-test/test-model", "--task", "csv",
    "--repeats", "2", "--out", join(root, "benchmark"), "--timeout", "10",
  ], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let benchOut = "", benchErr = "";
  bench.stdout.on("data", chunk => { benchOut += chunk; });
  bench.stderr.on("data", chunk => { benchErr += chunk; });
  t.after(() => bench.kill());
  const [benchCode] = await once(bench, "close");
  assert.equal(benchCode, 0, benchErr);
  const reportPath = /^Report: (.+)$/m.exec(benchOut)?.[1];
  assert.ok(reportPath, benchOut);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.summary.attempts, 2);
  assert.equal(report.summary.workflowErrors, 0);
  assert.equal(report.summary.baseline.checksTotal, 24);
  assert.equal(report.summary.refined.checksPassed, 0, "unchanged solution stubs must fail");
  for (const result of report.results) {
    assert.equal(result.stages.length, 8);
    assert.match(await readFile(join(result.runDir, "propose-general", "prompt.txt"), "utf8"), /"priorLessons": \[\]/);
    assert.equal(result.baseline.total, 12);
    assert.equal(result.refined.total, 12);
  }
});

test("Pi adapter rejects empty completions and retains the transcript", { timeout: 10000 }, async (t) => {
  const { root, runtime } = await localProvider(t, (_, res) => send(res, { content: "" }));
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", modelRuntime: runtime });
  await assert.rejects(agent.call({
    stage: "test", cwd: root, artifactDir: root, instructions: "Be brief", prompt: "Hello",
    tools: false, signal: new AbortController().signal,
  }), /empty response/);
  assert.ok(JSON.parse(await readFile(join(root, "messages.json"), "utf8")).length > 0);
});

test("Pi adapter cancels an active model stream and closes the session", { timeout: 10000 }, async (t) => {
  const controller = new AbortController();
  const { root, runtime } = await localProvider(t, (_, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    controller.abort(new Error("test cancellation"));
  });
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", modelRuntime: runtime });
  await assert.rejects(agent.call({
    stage: "test", cwd: root, artifactDir: root, instructions: "Be brief", prompt: "Hello",
    tools: false, signal: controller.signal,
  }), /test cancellation/);
  assert.ok(JSON.parse(await readFile(join(root, "messages.json"), "utf8")).length > 0);
});

test("missing credentials do not turn Pi's placeholder into a selected model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi2-no-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  assert.equal(runtime.getAvailableSnapshot().length, 0);
  await assert.rejects(createPiAgent({ cwd: root, modelRuntime: runtime }), /No Pi model is available/);
});
