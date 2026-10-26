// P0.5 end-to-end: one-time pairing link -> auto machine -> device credential reconnect.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const state = mkdtempSync(join(tmpdir(), "remote-shell-pair-"));
process.env.REMOTE_SHELL_STATE_DIR = state;
process.env.REMOTE_SHELL_AGENT_PORT = process.env.REMOTE_SHELL_AGENT_PORT || String(48000 + (process.pid % 1000));
const agentPort = Number(process.env.REMOTE_SHELL_AGENT_PORT);
const { apply } = await import("../lib/index.mjs");

const agentBin = process.env.AGENT_BIN
  ? resolve(process.env.AGENT_BIN)
  : fileURLToPath(new URL("../../dist/remote-agent-linux-amd64", import.meta.url));
const creds = join(state, "credentials.json");

const tools = {};
const routes = [];
apply({
  tools: { register: (d) => { tools[d.name] = d; return () => {}; } },
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  effect: (fn) => { const d = fn(); return d || (() => {}); },
});

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://local").pathname;
  const route = routes.find((r) => path === r.path || path.startsWith(r.path + "/"));
  if (!route) { res.writeHead(404); res.end(); return; }
  await route.handler(req, res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const prefix = `ws://127.0.0.1:${agentPort}/api/remote-shell/agent`;
const cfgRes = await new Promise((resolve, reject) => {
  const raw = JSON.stringify({ name: "e2e 入口", publicUrl: prefix });
  const req = http.request(
    { host: "127.0.0.1", port, path: "/api/remote-shell/config", method: "PUT", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw) } },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    },
  );
  req.on("error", reject);
  req.end(raw);
});
if (!cfgRes?.ok || cfgRes.publicUrl !== prefix || cfgRes.name !== "e2e 入口") throw new Error(`config prefix failed: ${JSON.stringify(cfgRes)}`);

const body = JSON.stringify({ label: "e2e" });
const pairing = await new Promise((resolve, reject) => {
  const req = http.request(
    { host: "127.0.0.1", port, path: "/api/remote-shell/pairings", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
    (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    },
  );
  req.on("error", reject);
  req.end(body);
});
if (!pairing?.ok) throw new Error(`create pairing failed: ${JSON.stringify(pairing)}`);
if (!pairing.link.startsWith(prefix + "#")) throw new Error(`configured prefix not used: ${pairing.link}`);
console.log("pairing link ok");

const hosts = async () => (await tools.remote_hosts.execute({}, {})).machines;
const waitOnline = async (ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await hosts();
    const m = list.find((x) => x.status === "online");
    if (m) return m;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("agent never came online");
};

let agent = spawn(agentBin, ["--pair", pairing.link, "--credentials", creds, "--name", "pair-e2e"], { stdio: "inherit" });
const machine = await waitOnline();
if (!readFileSync(creds, "utf8").includes(machine.id)) throw new Error("credentials missing machine id");
const result = await tools.remote_exec.execute({ machine: machine.id, command: "uname -a", timeout_ms: 10000 }, {});
if (result.exitCode !== 0 || !result.stdout.includes("Linux")) throw new Error(`exec failed: ${JSON.stringify(result)}`);
console.log("paired + exec ok");

agent.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));

// Reconnect using only the saved device credential, no pairing link.
agent = spawn(agentBin, ["--credentials", creds, "--name", "pair-e2e"], { stdio: "inherit" });
await waitOnline();
console.log("device credential reconnect ok");
agent.kill("SIGTERM");

await new Promise((r) => setTimeout(r, 500));
server.close();
rmSync(state, { recursive: true, force: true });
console.log("PASS: pair -> auto register -> exec -> credential reconnect");
process.exit(0);
