import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** WorkBuddy owns the container; the model and durable journal remain on the host. */
export function remoteTools(url: string, token: string) {
  const invoke = async (name: string, args: unknown, signal?: AbortSignal) => {
    const response = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name, args }) });
    if (!response.ok) throw new Error(`Container tool failed (${response.status}): ${await response.text()}`);
    const result = await response.json() as { output: Array<{ type: "text"; text: string }>; error?: string };
    if (result.error) throw new Error(result.error);
    return { output: result.output };
  };
  return defineExtension({ name: "workbuddy-tools", tools: [
    defineTool({ name: "read", description: "Read a file in the task container. Paths are relative to /workspace. Supports images and text; use offset/limit for long text.",
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
      execute: (args, _api, ctx) => invoke("read", args, ctx.abortSignal) }),
    defineTool({ name: "write", description: "Write a UTF-8 file in the task container, creating parents.",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: (args, _api, ctx) => invoke("write", args, ctx.abortSignal) }),
    defineTool({ name: "edit", description: "Replace exactly one occurrence of oldText with newText in a file in the task container.",
      parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
      execute: (args, _api, ctx) => invoke("edit", args, ctx.abortSignal) }),
    defineTool({ name: "bash", description: "Execute a shell command inside the task container at /workspace.",
      parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
      execute: (args, _api, ctx) => invoke("bash", args, ctx.abortSignal) }),
  ] });
}
