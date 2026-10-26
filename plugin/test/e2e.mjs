// P0 end-to-end test: plugin host + real agent over WebSocket.
// Run after `make agent-linux` and `cd plugin && npm install`.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const state = mkdtempSync(join(tmpdir(), "remote-shell-e2e-"));
process.env.REMOTE_SHELL_STATE_DIR = state;
const { apply } = await import("../lib/index.mjs");

const agentBin = process.env.AGENT_BIN
  ? resolve(process.env.AGENT_BIN)
  : fileURLToPath(new URL("../../dist/remote-agent-linux-amd64", import.meta.url));
const tools = {};
const routes = [];
const upgrades = [];
apply({
  tools: { register: (d) => { tools[d.name] = d; return () => {}; } },
  webServer: {
    register: (r) => { routes.push(r); return () => {}; },
    registerUpgrade: (r) => { upgrades.push(r); return () => {}; },
  },
  effect: (fn) => { const d = fn(); return d || (() => {}); },
});

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://local").pathname;
  const route = routes.find((r) => path === r.path || path.startsWith(r.path + "/"));
  if (!route) { res.writeHead(404); res.end(); return; }
  await route.handler(req, res);
});
server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url, "http://local").pathname;
  const route = upgrades.find((r) => path === r.path);
  if (!route) { socket.destroy(); return; }
  route.handler(req, socket, head);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const body = JSON.stringify({ name: "e2e" });
const created = await new Promise((resolve, reject) => {
  const req = http.request(
    { host: "127.0.0.1", port, path: "/api/remote-shell/machines", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    },
  );
  req.on("error", reject);
  req.end(body);
});
if (!created?.ok) throw new Error("create machine failed");
const id = created.machine.id;
const tokenFile = join(state, "token.txt");
writeFileSync(tokenFile, created.token, { mode: 0o600 });

const agent = spawn(agentBin, [
  "--server", `ws://127.0.0.1:${port}/api/remote-shell/agent`,
  "--machine-id", id,
  "--token-file", tokenFile,
  "--name", "e2e",
], { stdio: "inherit" });

const hosts = async () => (await tools.remote_hosts.execute({}, {})).machines.find((m) => m.id === id);
const waitStatus = async (want, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = await hosts();
    if (m?.status === want) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`status never became ${want}`);
};

await waitStatus("online");
const result = await tools.remote_exec.execute({ machine: id, command: "uname -a", timeout_ms: 10000 }, {});
if (result.exitCode !== 0 || !result.stdout.includes("Linux")) throw new Error(`exec failed: ${JSON.stringify(result)}`);
agent.kill("SIGTERM");
await waitStatus("offline");
server.close();
rmSync(state, { recursive: true, force: true });
console.log("PASS: create -> online -> remote_exec -> offline");
process.exit(0);
