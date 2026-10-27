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

async function api(method, path, body) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/remote-shell" + path,
        method,
        headers: raw ? { "content-type": "application/json", "content-length": Buffer.byteLength(raw) } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
}

const presetA = await api("POST", "/presets", { label: "e2e 入口", url: prefix });
if (!presetA?.ok || presetA.preset.label !== "e2e 入口" || presetA.preset.url !== prefix) {
  throw new Error(`add preset failed: ${JSON.stringify(presetA)}`);
}
const other = "wss://example.invalid/api/remote-shell/agent";
const presetB = await api("POST", "/presets", { label: "备用入口", url: other });
if (!presetB?.ok) throw new Error(`add second preset failed: ${JSON.stringify(presetB)}`);

const switchedB = await api("POST", "/switch", { id: presetB.preset.id });
if (!switchedB?.ok || switchedB.currentId !== presetB.preset.id) throw new Error("switch to B failed");
const pairingB = await api("POST", "/pairings", { label: "switch-check" });
if (!pairingB?.ok || !pairingB.link.startsWith(other + "#")) throw new Error(`B prefix not used: ${pairingB.link}`);
await api("DELETE", `/pairings/${encodeURIComponent(pairingB.pairing.id)}`);

const switchedA = await api("POST", "/switch", { id: presetA.preset.id });
if (!switchedA?.ok || switchedA.currentId !== presetA.preset.id) throw new Error("switch back to A failed");
const cfg = await api("GET", "/config");
if (!cfg?.ok || cfg.presets.length !== 2 || cfg.currentId !== presetA.preset.id) throw new Error(`config list failed: ${JSON.stringify(cfg)}`);

const pairing = await api("POST", "/pairings", { label: "e2e" });
if (!pairing?.ok) throw new Error(`create pairing failed: ${JSON.stringify(pairing)}`);
if (!pairing.link.startsWith(prefix + "#")) throw new Error(`configured prefix not used: ${pairing.link}`);
console.log("pairing link ok");

const hosts = async () => (await tools.juzi_hosts.execute({}, {})).machines;
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
const result = await tools.juzi_exec.execute({ machine: machine.id, command: "uname -a", timeout_ms: 10000 }, {});
if (result.exitCode !== 0 || !result.stdout.includes("Linux")) throw new Error(`exec failed: ${JSON.stringify(result)}`);
const bashResult = await tools.juzi_exec.execute(
  { machine: machine.id, shell: "bash", command: "echo $BASH_VERSION", timeout_ms: 10000 },
  {},
);
if (bashResult.exitCode !== 0 || !bashResult.stdout.trim()) throw new Error(`bash shell failed: ${JSON.stringify(bashResult)}`);

const session = await tools.juzi_session_open.execute({ machine: machine.id, shell: "bash" }, {});
if (!session?.sessionId) throw new Error("session open failed");
const first = await tools.juzi_session_exec.execute(
  { session_id: session.sessionId, command: "cd /tmp && export DSH_SESSION_VALUE=42 && echo first", timeout_ms: 10000 },
  {},
);
if (first.exitCode !== 0 || !first.stdout.includes("first")) throw new Error(`session first failed: ${JSON.stringify(first)}`);
const second = await tools.juzi_session_exec.execute(
  { session_id: session.sessionId, command: "pwd; printf 'value=%s\\n' \"$DSH_SESSION_VALUE\"", timeout_ms: 10000 },
  {},
);
if (!second.stdout.includes("/tmp") || !second.stdout.includes("value=42")) {
  throw new Error(`session state not preserved: ${JSON.stringify(second)}`);
}
await tools.juzi_session_close.execute({ session_id: session.sessionId }, {});

const job = await tools.juzi_job_start.execute(
  { machine: machine.id, shell: "bash", command: "echo job-start; sleep 1; echo job-done", name: "e2e job" },
  {},
);
if (!job?.jobId) throw new Error(`job start failed: ${JSON.stringify(job)}`);
const jobStatus = await tools.juzi_job_status.execute({ job_id: job.jobId, wait_ms: 5000 }, {});
if (jobStatus.status !== "exited" || !jobStatus.stdoutTail.includes("job-done")) {
  throw new Error(`job status failed: ${JSON.stringify(jobStatus)}`);
}
const cancelJob = await tools.juzi_job_start.execute(
  { machine: machine.id, shell: "bash", command: "sleep 30", name: "cancel me" },
  {},
);
const canceled = await tools.juzi_job_cancel.execute({ job_id: cancelJob.jobId }, {});
if (!["canceled", "canceling"].includes(canceled.status)) throw new Error(`job cancel failed: ${JSON.stringify(canceled)}`);
const jobList = await tools.juzi_job_list.execute({ machine: machine.id }, {});
if (!Array.isArray(jobList.jobs) || jobList.jobs.length < 2) throw new Error(`job list failed: ${JSON.stringify(jobList)}`);
const jobsHttp = await api("GET", "/jobs");
if (!jobsHttp?.ok || !Array.isArray(jobsHttp.jobs) || jobsHttp.jobs.length < 2) throw new Error(`jobs HTTP failed: ${JSON.stringify(jobsHttp)}`);
const fileName = `juzi-e2e-${process.pid}.txt`;
const localUpload = join(state, "upload.txt");
const localDownload = join(state, "downloaded.txt");
const uploadBytes = Buffer.alloc(2 * 1024 * 1024 + 123);
for (let i = 0; i < uploadBytes.length; i++) uploadBytes[i] = i % 251;
writeFileSync(localUpload, uploadBytes);
const put = await tools.juzi_file_put.execute(
  { machine: machine.id, local_path: localUpload, remote_path: fileName },
  {},
);
let putStatus = await tools.juzi_transfer_status.execute({ transfer_id: put.transferId, wait_ms: 2000 }, {});
for (let i = 0; i < 10 && !["completed", "failed", "canceled"].includes(putStatus.status); i++) {
  putStatus = await tools.juzi_transfer_status.execute({ transfer_id: put.transferId, wait_ms: 2000 }, {});
}
if (putStatus.status !== "completed") throw new Error(`upload failed: ${JSON.stringify(putStatus)}`);
const get = await tools.juzi_file_get.execute(
  { machine: machine.id, remote_path: fileName, local_path: localDownload },
  {},
);
let getStatus = await tools.juzi_transfer_status.execute({ transfer_id: get.transferId, wait_ms: 2000 }, {});
for (let i = 0; i < 10 && !["completed", "failed", "canceled"].includes(getStatus.status); i++) {
  getStatus = await tools.juzi_transfer_status.execute({ transfer_id: get.transferId, wait_ms: 2000 }, {});
}
if (getStatus.status !== "completed") throw new Error(`download failed: ${JSON.stringify(getStatus)}`);
if (!readFileSync(localDownload).equals(readFileSync(localUpload))) {
  throw new Error("file content mismatch");
}
const overwriteDenied = await tools.juzi_file_put.execute(
  { machine: machine.id, local_path: localUpload, remote_path: fileName },
  {},
);
let deniedStatus = await tools.juzi_transfer_status.execute({ transfer_id: overwriteDenied.transferId, wait_ms: 2000 }, {});
for (let i = 0; i < 5 && !["completed", "failed", "canceled"].includes(deniedStatus.status); i++) {
  deniedStatus = await tools.juzi_transfer_status.execute({ transfer_id: overwriteDenied.transferId, wait_ms: 2000 }, {});
}
if (deniedStatus.status !== "failed" || deniedStatus.error !== "exists") {
  throw new Error(`overwrite guard failed: ${JSON.stringify(deniedStatus)}`);
}
const transferList = await tools.juzi_transfer_list.execute({ machine: machine.id }, {});
if (!Array.isArray(transferList.transfers) || transferList.transfers.length < 2) {
  throw new Error(`transfer list failed: ${JSON.stringify(transferList)}`);
}
const cancelPut = await tools.juzi_file_put.execute(
  { machine: machine.id, local_path: localUpload, remote_path: `${fileName}.cancel` },
  {},
);
const cancelResult = await tools.juzi_transfer_cancel.execute({ transfer_id: cancelPut.transferId }, {});
if (cancelResult.status !== "canceled") throw new Error(`cancel failed: ${JSON.stringify(cancelResult)}`);
const transfersHttp = await api("GET", "/transfers");
if (!transfersHttp?.ok || !Array.isArray(transfersHttp.transfers) || transfersHttp.transfers.length < 2) {
  throw new Error(`transfers HTTP failed: ${JSON.stringify(transfersHttp)}`);
}
await tools.juzi_exec.execute({ machine: machine.id, shell: "bash", command: `rm -f ~/Downloads/${fileName} ~/Downloads/${fileName}.cancel ~/Downloads/${fileName}.cancel.part ~/Downloads/${fileName}.cancel.part.meta` }, {});
console.log("paired + exec ok (cmd default + bash shell + persistent session + async jobs + files)");

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
