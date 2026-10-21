import { readFile } from "node:fs/promises";
import { createPiAgent } from "./pi.js";
import { writeJson } from "./storage.js";

// One Harbor solver rollout. Never runs the recursive method inside a trial.
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try {
  const request = JSON.parse(await readFile(process.argv[2], "utf8"));
  const agent = await createPiAgent({ cwd: request.cwd, model: request.model, thinkingLevel: request.thinkingLevel, signal: controller.signal });
  const result = await agent.call({ ...request, signal: controller.signal });
  await writeJson(process.argv[3], result);
} catch (error) { process.stderr.write(String(error) + "\n"); process.exitCode = 1; }
