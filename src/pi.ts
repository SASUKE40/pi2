import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
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
import { CodingTools, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { AgentCall } from "./core.js";
import { frontmatter, HARNESS_ROOT, subagentNames, withoutFrontmatter } from "./harness.js";
import { contains, writeJson } from "./storage.js";
import { remoteTools } from "./remote.js";

const SUBAGENT_PREAMBLE = "You are a delegated subagent working in the same workspace as the agent that called you. You do not see its conversation or its instructions: only your role below and the task in the user message. Do that task with the available tools and return a concise text answer.";

/** Resolve a tool path and require it, or its nearest existing ancestor, to stay inside `root`. */
async function confine(root: string, cwd: string, path: string): Promise<string> {
  const absolute = resolve(cwd, path);
  let existing = absolute, rest = "";
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      rest = rest ? join(basename(existing), rest) : basename(existing);
      existing = dirname(existing);
    }
  }
  const real = rest ? join(existing, rest) : existing;
  if (!contains(root, real)) throw new Error(`Access is restricted to ${relative(cwd, root) || "."}/`);
  return real;
}

type Tool = { execute: (args: any, api: any, ctx: any) => any };
function restricted<T extends Tool>(tool: T, root: string, cwd: string): T {
  return { ...tool, execute: async (args: { path: string }, api: unknown, ctx: unknown) => tool.execute({ ...args, path: await confine(root, cwd, args.path) }, api, ctx) };
}

/** ls and read over the evidence; write, edit and delete over the harness tree when editing. */
async function evidenceTools(cwd: string, evidenceDir: string, editDir?: string): Promise<Extension> {
  const root = await realpath(evidenceDir);
  const ls = defineTool({
    name: "ls", description: "List a directory under context/ recursively (directories end in /). Use it to inventory evidence before reading.",
    parameters: Type.Object({ path: Type.String({ description: "Directory to list, e.g. context/ or context/pool/" }) }), replay: "safe",
    execute: async args => {
      const dir = await confine(root, cwd, args.path);
      const entries = (await readdir(dir, { recursive: true, withFileTypes: true }))
        .map(entry => relative(dir, join(entry.parentPath, entry.name)) + (entry.isDirectory() ? "/" : "")).sort();
      const shown = entries.slice(0, 2000);
      return { output: [{ type: "text", text: (shown.join("\n") || "(empty)") + (entries.length > shown.length ? `\n… ${entries.length - shown.length} more` : "") }] };
    },
  });
  const tools: unknown[] = [ls, restricted(createReadTool(), root, cwd)];
  if (editDir) {
    await mkdir(editDir, { recursive: true });
    const tree = await realpath(editDir);
    const remove = defineTool({
      name: "delete", description: "Delete a file or directory under context/harness/ to remove that harness component.",
      parameters: Type.Object({ path: Type.String() }), replay: "safe",
      execute: async args => {
        const target = await confine(tree, cwd, args.path);
        if (target === tree) throw new Error("Delete individual components, not the whole harness");
        await rm(target, { recursive: true, force: true });
        return { output: [{ type: "text", text: `Deleted ${args.path}` }] };
      },
    });
    tools.push(restricted(createWriteTool(), tree, cwd), restricted(createEditTool(), tree, cwd), remove);
  }
  return defineExtension({ name: "evidence", tools: tools as Extension["tools"] });
}

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
    else if (request.evidenceDir) registry.install(await evidenceTools(request.cwd, request.evidenceDir, request.editDir));
    const files = request.harness ?? {};
    const delegates = Object.fromEntries(subagentNames(files).map(name => [name, files[`sub_agents/${name}/AGENT.md`]]));
    if (request.tools && Object.keys(delegates).length) {
      const delegate = defineTool({
        name: "subagent",
        description: `Run a delegated subagent in its own context; it returns text. Available:\n${Object.entries(delegates)
          .map(([name, text]) => `- ${name}: ${frontmatter(text, "description") ?? ""}`).join("\n")}`,
        parameters: Type.Object({ name: Type.String(), task: Type.String() }), replay: "safe",
        execute: async (args, api, ctx) => {
          if (!Object.hasOwn(delegates, args.name)) throw new Error(`Unknown subagent: ${args.name}`);
          const childId = await api.commit(async tx => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing) return existing.id;
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
            await configure(tx, child.id, { instructions: `${SUBAGENT_PREAMBLE}\n\n${withoutFrontmatter(delegates[args.name])}`, tools: coding.tools });
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
      for (const path of Object.keys(files).filter(p => p.startsWith("plugin/"))) {
        const factory = (await import(pathToFileURL(join(request.cwd, HARNESS_ROOT, path)).href)).default;
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
          cwd: request.cwd, instructions: request.instructions,
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
