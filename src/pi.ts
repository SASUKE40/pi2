import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentCall } from "./core.js";
import { writeJson } from "./storage.js";

function loader(cwd: string, settingsManager: SettingsManager, instructions: string, tools: boolean): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd, agentDir: getAgentDir(), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: !tools,
    systemPromptOverride: () => tools ? undefined : instructions,
    appendSystemPromptOverride: () => tools && instructions ? [instructions] : [],
  });
}

/** Keep text and tool calls/results as evidence; omit large binary image payloads. */
function transcript(messages: unknown[]): string {
  return messages.map((message) => JSON.stringify(message, (key, value) => key === "data" && typeof value === "string" ? "[binary omitted]" : value)).join("\n");
}

export async function createPiAgent(options: {
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  modelRuntime?: ModelRuntime;
}): Promise<{ call: AgentCall; model: string; thinkingLevel: string }> {
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({ signal: options.signal });
  const configured = SettingsManager.create(options.cwd);
  const settings = {
    defaultProvider: configured.getDefaultProvider(),
    defaultModel: configured.getDefaultModel(),
    defaultThinkingLevel: configured.getDefaultThinkingLevel(),
  };
  let explicitModel;
  if (options.model) {
    const slash = options.model.indexOf("/");
    if (slash < 1 || slash === options.model.length - 1) throw new Error("--model must be provider/model");
    explicitModel = modelRuntime.getModel(options.model.slice(0, slash), options.model.slice(slash + 1));
    if (!explicitModel) throw new Error(`Unknown Pi model: ${options.model}`);
  }
  const bootstrapSettings = SettingsManager.inMemory(settings);
  const bootstrapLoader = loader(options.cwd, bootstrapSettings, "Select a model.", false);
  await bootstrapLoader.reload();
  const { session: bootstrap } = await createAgentSession({
    cwd: options.cwd, model: explicitModel, modelRuntime,
    settingsManager: bootstrapSettings, resourceLoader: bootstrapLoader,
    sessionManager: SessionManager.inMemory(options.cwd), tools: [],
  });
  const model = bootstrap.model;
  const thinkingLevel = bootstrap.thinkingLevel;
  bootstrap.dispose();
  // Pi's low-level agent exposes an unknown/unknown placeholder when selection found no model.
  if (!model || !modelRuntime.getModel(model.provider, model.id)) {
    throw new Error("No Pi model is available. Run `npx --no-install pi` and /login, or configure a supported provider API key.");
  }
  options.signal?.throwIfAborted();

  const call: AgentCall = async (request) => {
    request.signal.throwIfAborted();
    const settingsManager = SettingsManager.inMemory(settings);
    const resourceLoader = loader(request.cwd, settingsManager, request.instructions, request.tools);
    await resourceLoader.reload();
    request.signal.throwIfAborted();
    const { session } = await createAgentSession({
      cwd: request.cwd, model, thinkingLevel, modelRuntime, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(request.cwd),
      tools: request.tools ? ["read", "bash", "edit", "write"] : [],
    });
    const abort = () => { void session.abort().catch(() => {}); };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      request.signal.throwIfAborted();
      await session.prompt(request.prompt);
      request.signal.throwIfAborted();
      const last = session.messages.findLast((message) => message.role === "assistant");
      if (!last || last.role !== "assistant") throw new Error("Pi returned no assistant response");
      if (last.stopReason !== "stop") throw new Error(last.errorMessage || `Pi stopped with ${last.stopReason}`);
      const text = session.getLastAssistantText();
      if (!text) throw new Error("Pi returned an empty response");
      return { text, trace: transcript(session.messages) };
    } finally {
      request.signal.removeEventListener("abort", abort);
      try {
        await writeJson(join(request.artifactDir, "messages.json"), session.messages);
      } finally {
        session.dispose();
      }
    }
  };
  return { call, model: `${model.provider}/${model.id}`, thinkingLevel };
}
