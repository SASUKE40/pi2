"""Harbor adapter: Pi Durable on the host, all solver file/shell tools in the trial.

Copied by setup into WorkBuddy's agents package. This does not import or invoke
OpenCode, Codex, or pi-coding-agent. Host credentials are never sent to the task.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
import secrets
import shlex

from harbor.agents.installed.base import BaseInstalledAgent
from workbuddy_bench.agents._agent_user import ensure_agent_user


# Input is base64 JSON, not interpolated Python or shell code.
FILE_TOOL = r'''
import base64, json, mimetypes, os, pathlib, sys
r = json.loads(base64.b64decode(sys.argv[1]))
a, name = r['args'], r['name']
p = pathlib.Path(a['path'])
if not p.is_absolute(): p = pathlib.Path('/workspace') / p
if name == 'read':
    mime = mimetypes.guess_type(str(p))[0]
    if mime in ('image/png', 'image/jpeg', 'image/gif', 'image/webp'):
        if p.stat().st_size > 10 * 1024 * 1024: raise ValueError('Image exceeds 10 MiB')
        result = [{'type': 'image', 'mimeType': mime, 'data': base64.b64encode(p.read_bytes()).decode()}]
    else:
        offset = max(1, int(a.get('offset') or 1))
        limit = max(1, min(2000, int(a.get('limit') or 2000)))
        lines = p.read_text(errors='replace').splitlines()
        body = '\n'.join(lines[offset-1:offset-1+limit])
        result = [{'type': 'text', 'text': body[:50000] + ('\n[truncated; continue with offset]' if len(body)>50000 or len(lines)>=offset+limit else '')}]
elif name == 'write':
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(a['content'])
    result = [{'type': 'text', 'text': 'Wrote ' + str(p)}]
elif name == 'edit':
    body = p.read_text()
    if not a['oldText'] or body.count(a['oldText']) != 1: raise ValueError('oldText must match exactly once')
    p.write_text(body.replace(a['oldText'], a['newText'], 1))
    result = [{'type': 'text', 'text': 'Edited ' + str(p)}]
else: raise ValueError('Unknown file tool')
print(json.dumps({'output': result}))
'''


class PiAgent(BaseInstalledAgent):
    def __init__(self, logs_dir, *args, **kwargs):
        self.request_file = Path(kwargs.pop("PI2_REQUEST"))
        self.response_file = Path(kwargs.pop("PI2_RESPONSE"))
        self.node = kwargs.pop("PI2_NODE")
        self.worker = kwargs.pop("PI2_WORKER")
        self.timeout = float(kwargs.pop("PI2_TIMEOUT", 600))
        super().__init__(logs_dir, *args, version="1.3.0", **kwargs)

    @staticmethod
    def name():
        return "pi2"

    def get_version_command(self):
        return None  # The executor runs on the host, so there is no container CLI.

    async def install(self, environment):
        await ensure_agent_user(self, environment)
        result = await self.exec_as_agent(environment, command="python3 --version", timeout_sec=30)
        if result.return_code:
            raise RuntimeError("WorkBuddy task image needs python3 for Pi file tools")

    async def run(self, instruction, environment, context):
        request = json.loads(self.request_file.read_text())
        request["prompt"] = self.render_instruction(instruction)
        self.request_file.write_text(json.dumps(request))
        files = request.get("harness") or {}
        # Install the same skill/script tree at the relative path used by local Pi.
        payload = base64.b64encode(json.dumps(files).encode()).decode()
        install = "import json,base64,pathlib; r=pathlib.Path('/workspace/.pi2-harness'); r.mkdir(exist_ok=True); " \
                  "[(p.parent.mkdir(parents=True,exist_ok=True),p.write_text(v)) for k,v in json.loads(base64.b64decode(" + repr(payload) + ")).items() for p in [r/k]]"
        result = await self.exec_as_agent(environment, command="python3 -c " + shlex.quote(install), timeout_sec=30)
        if result.return_code:
            raise RuntimeError(result.stderr)
        token = secrets.token_urlsafe(32)
        active = set()

        async def handle(reader, writer):
            current = asyncio.current_task()
            active.add(current)
            try:
                header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 30)
                headers = dict(line.decode().split(":", 1) for line in header.split(b"\r\n")[1:] if b":" in line)
                headers = {k.lower(): v.strip() for k, v in headers.items()}
                if headers.get("authorization") != "Bearer " + token:
                    raise ValueError("Unauthorized")
                size = int(headers.get("content-length", "0"))
                if size < 1 or size > 2_000_000:
                    raise ValueError("Invalid request size")
                data = json.loads(await asyncio.wait_for(reader.readexactly(size), 30))
                if data["name"] == "bash":
                    timeout = max(1, min(self.timeout, float(data["args"].get("timeout") or 120)))
                    result = await self.exec_as_agent(environment, command=data["args"]["command"], cwd="/workspace", timeout_sec=int(timeout))
                    body = {"output": [{"type": "text", "text": ((result.stdout or "") + (result.stderr or ""))[-50000:] + f"\n[exit {result.return_code}]"}]}
                elif data["name"] in ("read", "write", "edit"):
                    encoded = base64.b64encode(json.dumps(data).encode()).decode()
                    result = await self.exec_as_agent(environment, command=f"python3 -c {shlex.quote(FILE_TOOL)} {shlex.quote(encoded)}", cwd="/workspace", timeout_sec=60)
                    if result.return_code:
                        raise RuntimeError(result.stderr or result.stdout)
                    body = json.loads(result.stdout)
                else:
                    raise ValueError("Unknown tool")
            except Exception as exc:
                body = {"error": str(exc)}
            try:
                raw = json.dumps(body).encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + str(len(raw)).encode() + b"\r\n\r\n" + raw)
                await writer.drain()
            finally:
                writer.close()
                active.discard(current)

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        process = None
        log = self.logs_dir / "pi2.log"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        try:
            with log.open("w") as stream:
                process = await asyncio.create_subprocess_exec(
                    self.node, self.worker, str(self.request_file), str(self.response_file),
                    env={**os.environ, "PI2_REMOTE_URL": f"http://127.0.0.1:{port}/", "PI2_REMOTE_TOKEN": token},
                    stdout=stream, stderr=stream,
                )
                code = await asyncio.wait_for(process.wait(), self.timeout)
                if code:
                    raise RuntimeError(f"Pi Durable exited {code}; see {log}")
        finally:
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            server.close()
            await server.wait_closed()
            for task in active:
                task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
        usage_file = Path(request["artifactDir"]) / "usage.json"
        if usage_file.is_file():
            usage = json.loads(usage_file.read_text())
            buckets = list(usage.get("models", {}).values()) + list(usage.get("tools", {}).values())
            context.n_input_tokens = sum(u.get("input", 0) for u in buckets)
            context.n_output_tokens = sum(u.get("output", 0) for u in buckets)
            context.n_cache_tokens = sum(u.get("cacheRead", 0) for u in buckets)
            context.cost_usd = sum(u.get("cost", {}).get("total", 0) for u in buckets)
