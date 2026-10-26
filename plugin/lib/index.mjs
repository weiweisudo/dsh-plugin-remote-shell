import { defineTool } from "@deepseek-ai/dsh-tools";
import http from "node:http";
import { WebSocketServer } from "ws";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const name = "dsh-plugin-remote-shell";
export const inject = ["webServer", "tools"];

const BASE = "/api/remote-shell";
const AGENT_PATH = `${BASE}/agent`;
const STATE_DIR = process.env.REMOTE_SHELL_STATE_DIR || join(process.env.HOME || "/root", ".dsh", "remote-shell");
const AGENT_HOST = process.env.REMOTE_SHELL_LISTEN_HOST || "0.0.0.0";
const AGENT_PORT = Math.max(1, Math.min(65535, Number(process.env.REMOTE_SHELL_AGENT_PORT) || 47777));
const MACHINES_FILE = join(STATE_DIR, "machines.json");
const SECRETS_FILE = join(STATE_DIR, "secrets.json");

const nowISO = () => new Date().toISOString();

function readJSON(file, fallback) {
	try {
		if (!existsSync(file)) return fallback;
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJSON(file, value) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	try {
		chmodSync(tmp, 0o600);
	} catch {}
	// rename is atomic on the same filesystem
	try {
		renameSync(tmp, file);
	} catch {
		writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	}
}

function tokenHash(token) {
	return createHash("sha256").update(String(token)).digest("hex");
}

function safeEqualHex(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class MachineStore {
	constructor() {
		this.machines = readJSON(MACHINES_FILE, { machines: [] });
		this.secrets = readJSON(SECRETS_FILE, { tokens: {} });
		if (!Array.isArray(this.machines.machines)) this.machines.machines = [];
		if (typeof this.secrets.tokens !== "object" || this.secrets.tokens === null) this.secrets.tokens = {};
	}

	save() {
		writeJSON(MACHINES_FILE, this.machines);
		writeJSON(SECRETS_FILE, this.secrets);
	}

	list() {
		return [...this.machines.machines].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
	}

	get(id) {
		return this.machines.machines.find((m) => m.id === id);
	}

	find(query) {
		const q = String(query || "").trim();
		if (!q) return null;
		const exact = this.machines.machines.filter((m) => m.id === q || m.name === q);
		if (exact.length === 1) return exact[0];
		const fuzzy = this.machines.machines.filter(
			(m) => m.id.includes(q) || String(m.name || "").includes(q),
		);
		return fuzzy.length === 1 ? fuzzy[0] : null;
	}

	create(name) {
		const id = `m_${randomBytes(6).toString("hex")}`;
		const token = randomBytes(32).toString("hex");
		const machine = {
			id,
			name: String(name || id).slice(0, 80),
			os: "",
			arch: "",
			status: "offline",
			created_at: nowISO(),
			last_seen: null,
		};
		this.machines.machines.push(machine);
		this.secrets.tokens[id] = tokenHash(token);
		this.save();
		return { machine, token };
	}

	touch(id, patch = {}) {
		const m = this.get(id);
		if (!m) return null;
		Object.assign(m, patch, { last_seen: nowISO() });
		this.save();
		return m;
	}

	remove(id) {
		const before = this.machines.machines.length;
		this.machines.machines = this.machines.machines.filter((m) => m.id !== id);
		delete this.secrets.tokens[id];
		const changed = this.machines.machines.length !== before;
		if (changed) this.save();
		return changed;
	}

	verify(id, token) {
		const expected = this.secrets.tokens[id];
		return typeof expected === "string" && safeEqualHex(expected, tokenHash(token));
	}
}

class MachineHub {
	constructor(store) {
		this.store = store;
		this.agents = new Map(); // machineId -> { ws, lastSeen, pingTimer }
		this.pending = new Map(); // request id -> { resolve, reject, timer, machineId }
	}

	attach(ws, machine) {
		if (this.agents.has(machine.id)) {
			ws.close(4009, "machine already connected");
			return;
		}
		const entry = { ws, lastSeen: Date.now(), pingTimer: null };
		this.agents.set(machine.id, entry);
		this.store.touch(machine.id, { status: "online" });
		console.info(`[remote-shell] agent online: ${machine.id} ${machine.name || ""}`);

		entry.pingTimer = setInterval(() => {
			if (ws.readyState !== 1) return;
			try {
				ws.send(JSON.stringify({ type: "ping", time: nowISO() }));
			} catch {}
		}, 30_000);

		ws.on("message", (data) => this.onMessage(machine.id, entry, data));
		ws.on("close", () => this.detach(machine.id, entry));
		ws.on("error", () => {});
		this.send(machine.id, { type: "hello_ok", time: nowISO() });
	}

	onMessage(machineId, entry, raw) {
		let msg;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			try {
				entry.ws.close(1007, "invalid JSON");
			} catch {}
			return;
		}
		entry.lastSeen = Date.now();
		switch (msg.type) {
			case "hello":
				this.store.touch(machineId, {
					os: String(msg.os || ""),
					arch: String(msg.arch || ""),
					name: String(msg.name || this.store.get(machineId)?.name || machineId).slice(0, 80),
					status: "online",
				});
				break;
			case "heartbeat":
				this.store.touch(machineId, { status: "online" });
				break;
			case "exec_result": {
				const pending = this.pending.get(msg.id);
				if (!pending) break;
				clearTimeout(pending.timer);
				this.pending.delete(msg.id);
				pending.resolve({
					exitCode: Number(msg.exit_code ?? -1),
					stdout: String(msg.stdout ?? ""),
					stderr: String(msg.stderr ?? ""),
					truncated: Boolean(msg.truncated),
					timedOut: Boolean(msg.timed_out),
					durationMs: Number(msg.duration_ms ?? 0),
				});
				break;
			}
			case "ping":
				this.send(machineId, { type: "pong", time: nowISO() });
				break;
			default:
				break;
		}
	}

	detach(machineId, entry) {
		if (this.agents.get(machineId) !== entry) return;
		this.agents.delete(machineId);
		if (entry.pingTimer) clearInterval(entry.pingTimer);
		this.store.touch(machineId, { status: "offline" });
		for (const [id, p] of this.pending) {
			if (p.machineId !== machineId) continue;
			clearTimeout(p.timer);
			this.pending.delete(id);
			p.reject(new Error(`machine ${machineId} disconnected`));
		}
		console.info(`[remote-shell] agent offline: ${machineId}`);
	}

	send(machineId, payload) {
		const entry = this.agents.get(machineId);
		if (!entry || entry.ws.readyState !== 1) return false;
		try {
			entry.ws.send(JSON.stringify(payload));
			return true;
		} catch {
			return false;
		}
	}

	onlineIds() {
		return [...this.agents.keys()];
	}

	list() {
		return this.store.list().map((m) => {
			const live = this.agents.get(m.id);
			return {
				id: m.id,
				name: m.name,
				os: m.os || "",
				arch: m.arch || "",
				status: live ? "online" : "offline",
				created_at: m.created_at,
				...(live
					? { last_seen: new Date(live.lastSeen).toISOString() }
					: m.last_seen
						? { last_seen: m.last_seen }
						: {}),
			};
		});
	}

	async exec(machineId, command, timeoutMs = 60_000) {
		const entry = this.agents.get(machineId);
		if (!entry || entry.ws.readyState !== 1) throw new Error(`machine ${machineId} is offline`);
		const id = randomUUID();
		const timeout = Math.max(1_000, Math.min(3_600_000, Number(timeoutMs) || 60_000));
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`command timed out after ${timeout} ms`));
			}, timeout + 5_000);
			this.pending.set(id, { resolve, reject, timer, machineId });
			const ok = this.send(machineId, {
				type: "exec",
				id,
				command,
				timeout_seconds: Math.ceil(timeout / 1000),
			});
			if (!ok) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`failed to send command to ${machineId}`));
			}
		});
	}

	disconnect(machineId) {
		const entry = this.agents.get(machineId);
		if (entry) {
			try {
				entry.ws.close(1000, "revoked");
			} catch {}
		}
	}

	closeAll() {
		for (const [id, entry] of this.agents) {
			try {
				entry.ws.close(1001, "server shutting down");
			} catch {}
			this.agents.delete(id);
		}
	}
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

function agentCommand(req, machineId) {
	const proto = process.env.REMOTE_SHELL_AGENT_TLS === "1" ? "wss" : "ws";
	const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1");
	const hostname = hostHeader.replace(/:[0-9]+$/, "");
	return `remote-agent --server ${proto}://${hostname}:${AGENT_PORT}${AGENT_PATH} --machine-id ${machineId} --token-file token.txt`;
}

export function apply(ctx) {
	const store = new MachineStore();
	const hub = new MachineHub(store);
	const wss = new WebSocketServer({ noServer: true });

	const authorize = (req) => {
		const header = String(req.headers.authorization || "");
		const match = /^Bearer\s+(.+)$/i.exec(header);
		const machineId = String(req.headers["x-machine-id"] || "");
		if (!match || !machineId) return null;
		const machine = store.get(machineId);
		if (!machine) return null;
		if (!store.verify(machineId, match[1])) return null;
		return machine;
	};

	// The DSH web port is behind lanmode password auth, which also gates
	// WebSocket upgrades. Keep the agent listener on its own port, like the
	// browser-skill daemon, and authenticate every agent with its own token.
	const agentServer = http.createServer((_req, res) => {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
	});
	agentServer.on("upgrade", (req, socket, head) => {
		const machine = authorize(req);
		if (!machine) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, machine));
	});
	ctx.effect(
		() => {
			agentServer.listen(AGENT_PORT, AGENT_HOST, () => {
				console.info(`[remote-shell] agent listener on ${AGENT_HOST}:${AGENT_PORT}${AGENT_PATH}`);
			});
			return () => {
				try {
					agentServer.close();
				} catch {}
			};
		},
		"remote-shell: agent listener",
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: `${BASE}/machines`,
				handler: async (req, res) => {
					const url = new URL(req.url || "/", "http://local");
					const rest = url.pathname.slice(`${BASE}/machines`.length).replace(/^\/+/, "");
					if (req.method === "GET" && rest === "") {
						return sendJson(res, 200, { ok: true, machines: hub.list() });
					}
					if (req.method === "POST" && rest === "") {
						const body = await readBody(req);
						if (body === null) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
						const { machine, token } = store.create(String(body.name || "").trim() || undefined);
						return sendJson(res, 200, {
							ok: true,
							machine,
							token,
							command: agentCommand(req, machine.id),
						});
					}
					if (req.method === "DELETE" && rest) {
						const machine = store.get(rest);
						if (!machine) return sendJson(res, 404, { ok: false, error: "machine not found" });
						hub.disconnect(machine.id);
						store.remove(machine.id);
						return sendJson(res, 200, { ok: true });
					}
					return sendJson(res, 405, { ok: false, error: "method not allowed" });
				},
			}),
		"remote-shell: machine api",
	);

	ctx.tools.register(
		defineTool({
			name: "remote_hosts",
			description: "List machines authorized for the remote-shell plugin and their online status.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						machines: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string", required: true },
									name: { type: "string", required: true },
									os: { type: "string" },
									arch: { type: "string" },
									status: { type: "string", required: true },
									created_at: { type: "string", required: true },
									last_seen: { type: "string" },
								},
							},
						},
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text:
							value.machines.length === 0
								? "没有已授权机器"
								: value.machines
										.map(
											(m) =>
												`- ${m.name} \`${m.id}\` ${m.status}${m.os ? ` ${m.os}/${m.arch}` : ""}${
													m.last_seen ? ` last=${m.last_seen}` : ""
												}`,
										)
										.join("\n"),
					},
				],
			},
			isConcurrencySafe: () => true,
			async execute() {
				return { machines: hub.list() };
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "remote_exec",
			description: "Run one non-interactive command on an authorized remote machine and return stdout/stderr/exit code.",
			parameters: {
				machine: { type: "string", required: true, description: "Machine id or exact name." },
				command: { type: "string", required: true, description: "Command to run." },
				timeout_ms: { type: "integer", description: "Timeout in ms (1000-3600000), default 60000." },
			},
			timeoutMs: 3_700_000,
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						machineId: { type: "string", required: true },
						name: { type: "string", required: true },
						command: { type: "string", required: true },
						exitCode: { type: "integer", required: true },
						stdout: { type: "string", required: true },
						stderr: { type: "string", required: true },
						truncated: { type: "boolean", required: true },
						timedOut: { type: "boolean", required: true },
						durationMs: { type: "number", required: true },
					},
				},
				render: (_args, value) => {
					const head = `${value.name} (${value.machineId}) exit ${value.exitCode}${
						value.timedOut ? " timed out" : ""
					}`;
					const body = [value.stdout, value.stderr].filter((s) => s.length > 0).join("\n");
					return [{ type: "text", text: body.length > 0 ? `${head}\n${body}` : head }];
				},
			},
			isConcurrencySafe: () => false,
			async execute(args) {
				const machine = store.find(args.machine);
				if (!machine) throw new Error(`machine not found: ${args.machine}`);
				if (!hub.agents.has(machine.id)) throw new Error(`machine offline: ${machine.name} (${machine.id})`);
				const command = String(args.command || "").trim();
				if (!command) throw new Error("command 不能为空");
				const result = await hub.exec(machine.id, command, args.timeout_ms ?? 60_000);
				return {
					machineId: machine.id,
					name: machine.name,
					command,
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
					truncated: result.truncated,
					timedOut: result.timedOut,
					durationMs: result.durationMs,
				};
			},
		}),
	);

	ctx.effect(
		() => () => {
			hub.closeAll();
			try {
				wss.close();
			} catch {}
			try {
				agentServer.close();
			} catch {}
		},
		"remote-shell: dispose",
	);

	const online = hub.onlineIds().length;
	console.info(`[remote-shell] loaded: ${store.list().length} machines, ${online} online`);
}
