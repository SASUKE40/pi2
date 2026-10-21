import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { processLock } from "@earendil-works/chord/node";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AssistantEntry, configure, createRegistry, defineExtension, defineTool, Harness, hook, section, ToolTask,
  type Extension,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools, createReadTool, type ReadToolInput } from "@earendil-works/pi-durable/tools";
import type { AgentCall } from "./core.js";
import { harnessInstructions } from "./harness.js";
import { contains, writeJson } from "./storage.js";
import { remoteTools } from "./remote.js";

export async function createPiAgent(options: {
  cwd: string; model?: string; improverModel?: string; thinkingLevel?: ModelThinkingLevel;
  signal?: AbortSignal; models?: Models;
}): Promise<{ call: AgentCall; model: string; improverModel: string; thinkingLevel: ModelThinkingLevel }> {
  // A module can supply custom providers or an application-owned credential store, without a coding-agent dependency.
  const modulePath = process.env.PI2_MODELS_MODULE;
  const models: Models = options.models ?? (modulePath
    ? await (await import(pathToFileURL(resolve(modulePath)).href)).default()
    : builtinModels());
  const selected = options.model ?? process.env.PI2_MODEL;
  async function choose(id: string | undefined) {
    if (id && (!id.includes("/") || id.startsWith("/") || id.endsWith("/"))) throw new Error("--model must be provider/model");
    const slash = id?.indexOf("/") ?? -1;
    const model = id ? models.getModel(id.slice(0, slash), id.slice(slash + 1)) : (await models.getAvailable(undefined, { signal: options.signal }))[0];
    if (!model) throw new Error(id ? `Unknown Pi model: ${id}` : "No Pi model is available. Configure a provider API key and --model provider/model.");
    if (!await models.getAuth(model, { signal: options.signal })) throw new Error(`No credentials for ${model.provider}`);
    return model;
  }
  const solver = await choose(selected);
  const improver = options.improverModel ? await choose(options.improverModel) : solver;
  const thinkingLevel = options.thinkingLevel ?? "medium";

  const call: AgentCall = async request => {
    request.signal.throwIfAborted();
    const context = withAbortSignal(request.signal, BACKGROUND_CONTEXT);
    const registry = createRegistry();
    const coding = process.env.PI2_REMOTE_URL ? remoteTools(process.env.PI2_REMOTE_URL, process.env.PI2_REMOTE_TOKEN ?? "") : CodingTools;
    if (request.tools) registry.install(coding);
    else if (request.evidenceDir) {
      const read = createReadTool();
      const root = await realpath(request.evidenceDir);
      const restricted = { ...read, execute: async (args: ReadToolInput, api: Parameters<typeof read.execute>[1], ctx: Parameters<typeof read.execute>[2]) => {
        const path = await realpath(resolve(request.cwd, args.path));
        if (!contains(root, path)) throw new Error("Read access is restricted to evidence/");
        return read.execute({ ...args, path }, api, ctx);
      } };
      registry.install(defineExtension({ name: "evidence", tools: [restricted] }));
    }
    const files = request.harness ?? { "systemprompt.md": request.instructions };
    const delegates = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("sub_agents/")).map(([p, text]) => [p.slice(11, -3), text]));
    if (request.tools && Object.keys(delegates).length) {
      const delegate = defineTool({
        name: "subagent", description: `Delegate to a specialist: ${Object.keys(delegates).join(", ")}.`,
        parameters: Type.Object({ name: Type.String(), task: Type.String() }), replay: "safe",
        execute: async (args, api, ctx) => {
          if (!Object.hasOwn(delegates, args.name)) throw new Error(`Unknown subagent: ${args.name}`);
          const childId = await api.commit(async tx => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing) return existing.id;
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
            await configure(tx, child.id, { instructions: harnessInstructions(files) + "\n\n" + delegates[args.name], tools: coding.tools });
            return child.id;
          }, ctx);
          const child = (await api.conversation(childId, ctx))!;
          const done = await (await child.submit({ type: "input", content: args.task, requestId: `delegate:${api.taskId}` }, ctx)).wait(ctx);
          if (done.status !== "done" || done.type !== "input") throw new Error("Subagent did not complete");
          const answer = await api.commit(tx => tx.entry(AssistantEntry, done.answer), ctx);
          return { output: answer?.model?.flatMap(m => m.role === "assistant" ? m.content.filter(c => c.type === "text") : []) ?? [] };
        },
      });
      registry.install(defineExtension({ name: "delegation", tools: [delegate] }));
    }
    if (request.tools) {
      for (const path of Object.keys(files).filter(p => p.startsWith("plugins/"))) {
        const factory = (await import(pathToFileURL(join(request.cwd, ".pi2-harness", path)).href)).default;
        if (typeof factory !== "function") throw new Error(`Plugin ${path} must export a factory`);
        const extension: Extension = await factory({ defineExtension, defineTool, hook, section, ToolTask, Type });
        if (!extension || typeof extension.name !== "string") throw new Error(`Plugin ${path} did not return an extension`);
        registry.install(extension);
      }
    }
    await mkdir(request.artifactDir, { recursive: true });
    const model = request.tools ? solver : improver;
    const unlock = await processLock(`pi2-stage:${await realpath(request.artifactDir)}`);
    try {
      const storage = await openNodeSqliteStorage(join(request.artifactDir, "session.sqlite"));
      const harness = await Harness.open(storage, {
        models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? request.cwd }),
        settings: { retry: { maxRetries: 2 }, stream: { timeoutMs: 120000 } },
      }, context).catch(async error => { await storage.close(BACKGROUND_CONTEXT); throw error; });
      try {
        const root = await harness.root(context, { agent: {
          model: { provider: model.provider, modelId: model.id }, thinkingLevel,
          cwd: request.cwd, instructions: request.tools
            ? `Complete the user's task using the available tools. Verify the requested deliverables.\n\n${harnessInstructions(files)}`
            : request.instructions,
        } });
        // Identical submissions recover the same pending or completed run after reopening SQLite.
        let submission = await root.submit({ type: "input", content: request.prompt, requestId: "stage" }, context);
        while ((await submission.status(context)).status === "unanswered") {
          submission = await root.submit({ type: "input", content: request.prompt, requestId: `retry:${submission.id}` }, context);
        }
        try {
          const done = await submission.wait(context);
          if (done.status !== "done" || done.type !== "input") throw new Error(`Pi Durable run failed: ${JSON.stringify(done)}`);
          const entry = await root.commit(tx => tx.entry(AssistantEntry, done.answer), context);
          const answer = entry?.model?.find(m => m.role === "assistant");
          const text = answer?.role === "assistant" ? answer.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
          if (!text.trim()) throw new Error("Pi returned an empty response");
          const transcript = await root.context(context);
          return { text, trace: JSON.stringify(transcript.entries, (key, value) => key === "data" && typeof value === "string" ? "[binary omitted]" : value) };
        } finally {
          const view = await root.context(BACKGROUND_CONTEXT);
          // Raw entries retain usage from failed attempts, even when model context excludes them.
          await writeJson(join(request.artifactDir, "messages.json"), view.entries.flatMap(entry => entry.model ?? []));
          await writeJson(join(request.artifactDir, "usage.json"), await harness.usage(BACKGROUND_CONTEXT));
        }
      } finally {
        // Closing suspends pending work and stops active invocations. Cancellation of a wait alone would not.
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally { await unlock(); }
  };
  return { call, model: `${solver.provider}/${solver.id}`, improverModel: `${improver.provider}/${improver.id}`, thinkingLevel };
}
