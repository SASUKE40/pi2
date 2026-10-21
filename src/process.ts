import { spawn } from "node:child_process";

/** Join the entire child group before releasing a stage or experiment lock. */
export async function runProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; input?: string;
} = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stopped = false;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    let force: NodeJS.Timeout | undefined;
    const stop = () => { stopped = true; kill("SIGTERM"); force ??= setTimeout(() => kill("SIGKILL"), 5000); };
    const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
    options.signal?.addEventListener("abort", stop, { once: true });
    const clean = () => { clearTimeout(timer); clearTimeout(force); options.signal?.removeEventListener("abort", stop); };
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 32_000_000) stop(); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on("error", error => { clean(); reject(error); });
    child.on("close", code => {
      if (stopped) kill("SIGKILL");
      clean();
      if (stopped || code !== 0) reject(new Error(`${command} ${stopped ? "cancelled or timed out" : `exited ${code}`}\n${stderr || stdout.slice(-16000)}`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
