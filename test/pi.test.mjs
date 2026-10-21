import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { pathToFileURL } from "node:url";
import { createPiAgent } from "../dist/pi.js";
import { runRefinement } from "../dist/core.js";
import { writeHarness } from "../dist/harness.js";

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
  const runtime = createModels();
  const providerConfig = {
    id: "local-test", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{
      id: "test-model", provider: "local-test", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", name: "Local deterministic test model", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  };
  runtime.setProvider(createProvider({ ...providerConfig,
    auth: { apiKey: { name: "local test", resolve: async () => ({ auth: { apiKey: "local-test-only" } }) } },
    api: openAICompletionsApi(),
  }));
  const modulePath = join(root, "models.mjs");
  await writeFile(modulePath, `import { createModels, createProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { openAICompletionsApi } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/api/openai-completions.lazy"))};
export default () => { const models = createModels(); models.setProvider(createProvider({ ...${JSON.stringify(providerConfig)},
auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } }, api: openAICompletionsApi() })); return models; };`);
  return { root, runtime, modulePath };
}

test("real Pi SDK sessions execute file tools through the complete refinement loop", { timeout: 20000 }, async (t) => {
  const requests = [];
  const { root, runtime, modulePath } = await localProvider(t, (body, res) => {
    requests.push(body);
    const names = (body.tools ?? []).map(tool => tool.function.name);
    const toolReplies = body.messages.filter((message) => message.role === "tool");
    if (!names.includes("bash") && names.includes("write")) {
      if (!toolReplies.length) return send(res, { tool_calls: [{ index: 0, id: "edit-harness", type: "function", function: { name: "write",
        arguments: JSON.stringify({ path: "context/harness/systemprompt.md", content: "Write result.txt and read it back to verify the result." }) } }] }, "tool_calls");
      return send(res, { content: "<notes>\nThe task requires a file artifact.\n</notes>" });
    }
    if (!names.includes("bash")) {
      return send(res, { content: "<edits>\ncomponent: systemprompt.md\ncandidates: probe-inv, composed\nchange: read back the artifact\nobserved: result.txt confirmed\nverdict: confounded\n</edits>\n\n<experience>\ncue: a task whose deliverable is a file\nlesson: systemprompt.md: write the artifact, then read it back\nevidence: composed wrote result.txt and confirmed it with read\nconfidence: low\n</experience>" });
    }
    if (toolReplies.length < 2) {
      const name = toolReplies.length === 0 ? "write" : "read";
      const args = name === "write" ? { path: "result.txt", content: "verified output" } : { path: "result.txt" };
      return send(res, { tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    }
    return send(res, { content: `Verified: ${toolReplies[1].content}` });
  });
  const cwd = join(root, "input");
  await mkdir(cwd);
  const agent = await createPiAgent({ cwd, model: "local-test/test-model", models: runtime });
  const result = await runRefinement({
    task: "Write verified output to result.txt and read it back.", cwd,
    stateDir: join(root, "state"), model: agent.model, timeoutMs: 10000,
  }, agent.call);
  assert.equal(await readFile(join(result.outputDir, "result.txt"), "utf8"), "verified output");
  await assert.rejects(readFile(join(cwd, "result.txt")), { code: "ENOENT" });
  assert.match(result.answer, /verified output/);
  assert.equal(result.learned, true);
  assert.equal(result.harness["systemprompt.md"], "Write result.txt and read it back to verify the result.");
  const toolset = request => (request.tools ?? []).map(tool => tool.function.name).sort().join(",");
  assert.equal(requests.filter(r => toolset(r) === "bash,edit,read,write").length, 12);
  assert.equal(requests.filter(r => toolset(r) === "delete,edit,ls,read,write").length, 6);
  assert.equal(requests.filter(r => toolset(r) === "ls,read").length, 1);
  assert.equal(requests.length, 19);
  const messages = JSON.parse(await readFile(join(result.runDir, "composed", "messages.json"), "utf8"));
  assert.equal(messages.filter((message) => message.role === "toolResult").length, 2);
  assert.ok(messages.some((message) => message.role === "toolResult" && message.toolName === "read" && !message.isError));

  // Exercise the actual CLI using a pi-ai provider module.
  const child = spawn(process.execPath, [
    "dist/cli.js", "Write verified output to result.txt and read it back.", "--cwd", cwd,
    "--model", "local-test/test-model", "--state-dir", join(root, "cli-state"), "--timeout", "10",
  ], { env: { ...process.env, PI2_MODELS_MODULE: modulePath }, stdio: ["ignore", "pipe", "pipe"] });
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
  ], { env: { ...process.env, PI2_MODELS_MODULE: modulePath }, stdio: ["ignore", "pipe", "pipe"] });
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
    const prompt = await readFile(join(result.runDir, "propose-inv", "prompt.txt"), "utf8");
    assert.match(prompt, /YOUR DIMENSION: INV/);
    assert.match(prompt, /context\/rollouts\/ +FULL trajectories: baseline\.md/);
    assert.doesNotMatch(prompt, /context\/library\/ +earlier tasks/, "fresh state has no library");
    assert.equal(result.baseline.total, 12);
    assert.equal(result.refined.total, 12);
  }
});

test("Pi adapter rejects empty completions and retains the transcript", { timeout: 10000 }, async (t) => {
  const { root, runtime } = await localProvider(t, (_, res) => send(res, { content: "" }));
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", models: runtime });
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
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", models: runtime });
  await assert.rejects(agent.call({
    stage: "test", cwd: root, artifactDir: root, instructions: "Be brief", prompt: "Hello",
    tools: false, signal: controller.signal,
  }), /test cancellation/);
  assert.ok(JSON.parse(await readFile(join(root, "messages.json"), "utf8")).length > 0);
});

test("empty model collections fail before running a task", async () => {
  await assert.rejects(createPiAgent({ cwd: process.cwd(), models: createModels() }), /No Pi model is available/);
});

test("SQLite reopens a completed stage without issuing another model call", async t => {
  let calls = 0;
  const { root, runtime } = await localProvider(t, (_, res) => { calls++; send(res, { content: "durable answer" }); });
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", models: runtime });
  const request = { stage: "test", cwd: root, artifactDir: root, instructions: "Be brief", prompt: "Hello", tools: false, signal: new AbortController().signal };
  assert.equal((await agent.call(request)).text, "durable answer");
  assert.equal((await agent.call(request)).text, "durable answer");
  assert.equal(calls, 1);
  assert.ok((await readFile(join(root, "session.sqlite"))).length > 0);
});

test("durable tools load skills, execute scripts and plugins, and join owned subagents", { timeout: 15000 }, async t => {
  const files = {
    "systemprompt.md": "Verify the result.", "guardrails.md": "Check units.", "LongTermMEMORY.md": "Values are signed.",
    "tool_descriptions/tool_guidance.md": "Read the skill and run its script.",
    "skills/verify/SKILL.md": "---\ndescription: when verifying a value\n---\nUse: node .pi2-harness/scripts/value.mjs",
    "scripts/value.mjs": 'console.log("script value: 42")',
    "sub_agents/reviewer/AGENT.md": "---\ndescription: reviews a result\n---\nRespond with child confirmed.",
    "plugin/check.mjs": `export default ({ defineExtension, defineTool, Type }) => defineExtension({ name: "checker", tools: [defineTool({
      name: "check_value", description: "Verify a value", parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "plugin confirmed" }] })
    })] });`,
  };
  const seen = [];
  const { root, runtime } = await localProvider(t, (body, res) => {
    const prompt = body.messages.find(m => m.role === "user")?.content;
    const tools = body.messages.filter(m => m.role === "tool");
    if (JSON.stringify(prompt).includes("Review this result")) {
      assert.ok(!body.tools.some(tool => tool.function.name === "subagent"));
      const system = JSON.stringify(body.messages.filter(m => m.role === "system" || m.role === "developer"));
      assert.match(system, /Respond with child confirmed/);
      assert.doesNotMatch(system, /Check units|description: reviews/);
      return send(res, { content: "child confirmed" });
    }
    assert.match(JSON.stringify(body.tools.find(tool => tool.function.name === "subagent")), /reviewer: reviews a result/);
    const actions = [
      ["read", { path: ".pi2-harness/skills/verify/SKILL.md" }],
      ["bash", { command: "node .pi2-harness/scripts/value.mjs" }],
      ["check_value", {}],
      ["subagent", { name: "reviewer", task: "Review this result" }],
    ];
    if (tools.length < actions.length) {
      const [name, args] = actions[tools.length];
      seen.push(name);
      return send(res, { tool_calls: [{ index: 0, id: `call-${tools.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    }
    assert.match(tools[1].content, /script value: 42/);
    assert.match(tools[2].content, /plugin confirmed/);
    assert.match(tools[3].content, /child confirmed/);
    return send(res, { content: "all components confirmed" });
  });
  await writeHarness(join(root, ".pi2-harness"), files);
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", models: runtime });
  const result = await agent.call({ stage: "test", cwd: root, artifactDir: root, instructions: "", harness: files,
    tools: true, prompt: "Use the harness components", signal: new AbortController().signal });
  assert.equal(result.text, "all components confirmed");
  assert.deepEqual(seen, ["read", "bash", "check_value", "subagent"]);
});

test("process death resumes pending generation without repeating a committed write tool", { timeout: 15000 }, async t => {
  let wrote = 0;
  let interrupt;
  let killed = false;
  const pending = new Promise(resolve => { interrupt = resolve; });
  const { root, runtime, modulePath } = await localProvider(t, (body, res) => {
    const replies = body.messages.filter(m => m.role === "tool");
    if (!replies.length) {
      wrote++;
      return send(res, { tool_calls: [{ index: 0, id: "write-once", type: "function", function: {
        name: "write", arguments: JSON.stringify({ path: "result.txt", content: "committed before crash" }),
      } }] }, "tool_calls");
    }
    if (!killed) { interrupt(); return; }
    return send(res, { content: "resumed after crash" });
  });
  const script = `import { createPiAgent } from ${JSON.stringify(new URL("../dist/pi.js", import.meta.url).href)};
const root = ${JSON.stringify(root)};
const agent = await createPiAgent({ cwd: root, model: "local-test/test-model" });
await agent.call({ stage: "test", cwd: root, artifactDir: root, instructions: "", prompt: "Write result", tools: true, signal: new AbortController().signal });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PI2_MODELS_MODULE: modulePath }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => child.kill("SIGKILL"));
  await Promise.race([pending, once(child, "close").then(() => { throw new Error(stderr || "child exited before crash point"); })]);
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  killed = true;
  assert.equal(await readFile(join(root, "result.txt"), "utf8"), "committed before crash");
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", models: runtime });
  const answer = await agent.call({ stage: "test", cwd: root, artifactDir: root, instructions: "", prompt: "Write result", tools: true, signal: new AbortController().signal });
  assert.equal(answer.text, "resumed after crash");
  assert.equal(wrote, 1);
});

test("editing sessions may write only inside the harness tree", { timeout: 10000 }, async t => {
  const actions = [
    ["write", { path: "context/outside.txt", content: "escape" }],
    ["write", { path: "context/harness/../task.md", content: "escape" }],
    ["write", { path: "context/harness/skills/x/SKILL.md", content: "---\ndescription: d\n---\nbody" }],
    ["edit", { path: "context/harness/systemprompt.md", edits: [{ oldText: "old", newText: "new" }] }],
    ["delete", { path: "context/harness/guardrails.md" }],
    ["delete", { path: "context/harness" }],
    ["ls", { path: "context" }],
    ["read", { path: "/etc/hosts" }],
  ];
  const { root, runtime } = await localProvider(t, (body, res) => {
    const replies = body.messages.filter(m => m.role === "tool");
    if (replies.length < actions.length) {
      const [name, args] = actions[replies.length];
      return send(res, { tool_calls: [{ index: 0, id: `call-${replies.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
    }
    assert.match(replies[0].content, /restricted/i);
    assert.match(replies[1].content, /restricted/i);
    assert.match(replies[5].content, /not the whole harness/);
    assert.match(replies[6].content, /harness\/skills\/x\/SKILL\.md/);
    assert.match(replies[7].content, /restricted/i);
    return send(res, { content: "<notes>KEEP_BASE</notes>" });
  });
  const context = join(root, "context");
  await mkdir(join(context, "harness"), { recursive: true });
  await writeFile(join(context, "task.md"), "task");
  await writeFile(join(context, "harness", "systemprompt.md"), "old");
  await writeFile(join(context, "harness", "guardrails.md"), "rules");
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", models: runtime });
  await agent.call({ stage: "edit", cwd: root, artifactDir: join(root, "artifacts"), instructions: "", prompt: "Edit",
    tools: false, evidenceDir: context, editDir: join(context, "harness"), signal: new AbortController().signal });
  assert.equal(await readFile(join(context, "harness", "systemprompt.md"), "utf8"), "new");
  assert.match(await readFile(join(context, "harness", "skills", "x", "SKILL.md"), "utf8"), /body/);
  await assert.rejects(readFile(join(context, "harness", "guardrails.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(context, "outside.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(context, "task.md"), "utf8"), "task");
});

test("solver and improver models route separately and readers get ls and read only", async t => {
  const modelsSeen = [];
  const { root, runtime } = await localProvider(t, (body, res) => {
    modelsSeen.push(body.model);
    if (body.model === "editor") {
      assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ["ls", "read"]);
      const reply = body.messages.find(m => m.role === "tool");
      if (!reply) return send(res, { tool_calls: [{ index: 0, id: "evidence", type: "function", function: {
        name: "read", arguments: JSON.stringify({ path: "evidence.txt" }),
      } }] }, "tool_calls");
      assert.match(reply.content, /artifact truth/);
    }
    return send(res, { content: "done" });
  });
  const solver = runtime.getModel("local-test", "test-model");
  runtime.setProvider(createProvider({ id: "local-test", models: [solver, { ...solver, id: "editor" }],
    auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } }, api: openAICompletionsApi(),
  }));
  await writeFile(join(root, "evidence.txt"), "artifact truth");
  const agent = await createPiAgent({ cwd: root, model: "local-test/test-model", improverModel: "local-test/editor", models: runtime });
  const request = { stage: "test", cwd: root, instructions: "", prompt: "Hello", signal: new AbortController().signal };
  await agent.call({ ...request, artifactDir: join(root, "solver"), tools: true });
  await agent.call({ ...request, artifactDir: join(root, "editor"), tools: false, evidenceDir: root });
  assert.deepEqual(modelsSeen, ["test-model", "editor", "editor"]);
});
