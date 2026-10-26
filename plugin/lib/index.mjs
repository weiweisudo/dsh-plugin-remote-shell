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
const PAIRINGS_FILE = join(STATE_DIR, "pairings.json");
const CONFIG_FILE = join(STATE_DIR, "config.json");

const PAIRING_TTL_MS = 5 * 60 * 1000;
const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

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

function randomToken() {
	return randomBytes(32).toString("base64url");
}

function loadConfig() {
	const raw = readJSON(CONFIG_FILE, {});
	let presets = Array.isArray(raw.presets)
		? raw.presets
				.filter((p) => p && typeof p.id === "string" && typeof p.url === "string")
				.map((p) => ({ id: p.id, label: String(p.label || "未命名"), url: p.url }))
		: [];
	// Migrate the earlier single name/publicUrl shape on first read.
	if (presets.length === 0 && typeof raw.publicUrl === "string" && raw.publicUrl.trim()) {
		presets = [{ id: "legacy", label: raw.name || "默认入口", url: raw.publicUrl }];
		return { presets, currentId: "legacy" };
	}
	const currentId =
		typeof raw.currentId === "string" && presets.some((p) => p.id === raw.currentId)
			? raw.currentId
			: presets[0]?.id || "";
	return { presets, currentId };
}

function saveConfig(cfg) {
	writeJSON(CONFIG_FILE, { presets: cfg.presets, currentId: cfg.currentId });
}

function normalizeLabel(raw) {
	const text = String(raw || "").trim().slice(0, 80);
	if (!text) throw new Error("名称不能为空");
	return text;
}

function normalizePrefix(raw) {
	const text = String(raw || "").trim();
	if (text === "") throw new Error("前缀不能为空");
	const u = new URL(text);
	if (u.protocol !== "ws:" && u.protocol !== "wss:") {
		throw new Error("前缀必须是 ws:// 或 wss:// 地址");
	}
	u.hash = "";
	if (!u.pathname || u.pathname === "/") u.pathname = AGENT_PATH;
	return u.toString().replace(/\/$/, "");
}

function currentPreset(cfg = loadConfig()) {
	return cfg.presets.find((p) => p.id === cfg.currentId) || null;
}

class MachineStore {
	constructor() {
		this.machines = readJSON(MACHINES_FILE, { machines: [] });
		this.secrets = readJSON(SECRETS_FILE, { tokens: {}, pairings: {} });
		this.pairings = readJSON(PAIRINGS_FILE, { pairings: [] });
		if (!Array.isArray(this.machines.machines)) this.machines.machines = [];
		if (!Array.isArray(this.pairings.pairings)) this.pairings.pairings = [];
		if (typeof this.secrets.tokens !== "object" || this.secrets.tokens === null) this.secrets.tokens = {};
		if (typeof this.secrets.pairings !== "object" || this.secrets.pairings === null) this.secrets.pairings = {};
	}

	save() {
		writeJSON(MACHINES_FILE, this.machines);
		writeJSON(SECRETS_FILE, this.secrets);
		writeJSON(PAIRINGS_FILE, this.pairings);
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

	createPairing(label) {
		const secret = randomToken();
		const pairing = {
			id: `p_${randomBytes(6).toString("hex")}`,
			label: String(label || "").slice(0, 80),
			created_at: nowISO(),
			expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
			used_at: null,
		};
		this.pairings.pairings.push(pairing);
		this.secrets.pairings[pairing.id] = tokenHash(secret);
		this.save();
		return { pairing, secret };
	}

	pendingPairings() {
		const now = Date.now();
		return this.pairings.pairings
			.filter((p) => !p.used_at && Date.parse(p.expires_at) > now)
			.map((p) => ({
				id: p.id,
				label: p.label,
				created_at: p.created_at,
				expires_at: p.expires_at,
			}));
	}

	findPairing(id) {
		return this.pairings.pairings.find((p) => p.id === id);
	}

	findPairingBySecret(secret) {
		const hash = tokenHash(secret);
		for (const pairing of this.pairings.pairings) {
			if (pairing.used_at) continue;
			if (Date.parse(pairing.expires_at) <= Date.now()) continue;
			if (safeEqualHex(this.secrets.pairings[pairing.id], hash)) return pairing;
		}
		return null;
	}

	cancelPairing(id) {
		const before = this.pairings.pairings.length;
		this.pairings.pairings = this.pairings.pairings.filter((p) => p.id !== id);
		delete this.secrets.pairings[id];
		if (before !== this.pairings.pairings.length) this.save();
		return before !== this.pairings.pairings.length;
	}

	createDeviceForPairing(pairing, hello) {
		const id = `m_${randomBytes(6).toString("hex")}`;
		const token = randomToken();
		const expires = new Date(Date.now() + DEVICE_TTL_MS).toISOString();
		const machine = {
			id,
			name: String(hello.name || pairing.label || id).slice(0, 80),
			os: String(hello.os || ""),
			arch: String(hello.arch || ""),
			status: "online",
			created_at: nowISO(),
			last_seen: nowISO(),
			device_expires_at: expires,
		};
		this.machines.machines.push(machine);
		this.secrets.tokens[id] = tokenHash(token);
		pairing.used_at = nowISO();
		this.save();
		return { machine, token, expires };
	}

	verifyDevice(id, token) {
		const expected = this.secrets.tokens[id];
		return typeof expected === "string" && safeEqualHex(expected, tokenHash(token));
	}

	rotateDevice(id) {
		const machine = this.get(id);
		if (!machine) return null;
		const token = randomToken();
		const expires = new Date(Date.now() + DEVICE_TTL_MS).toISOString();
		this.secrets.tokens[id] = tokenHash(token);
		machine.device_expires_at = expires;
		this.save();
		return { token, expires };
	}

	touch(id, patch = {}) {
		const m = this.get(id);
		if (!m) return null;
		Object.assign(m, patch, { last_seen: nowISO() });
		this.save();
		return m;
	}

	rename(id, name) {
		const m = this.get(id);
		if (!m) return null;
		m.name = String(name || m.name).slice(0, 80);
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
}

class MachineHub {
	constructor(store) {
		this.store = store;
		this.agents = new Map(); // machineId -> { ws, lastSeen, pingTimer }
		this.pairingAgents = new Set();
		this.pending = new Map();
		this.sessions = new Map(); // sessionId -> machineId
	}

	attachDevice(ws, machine, issued = null) {
		if (this.agents.has(machine.id)) {
			ws.close(4009, "machine already connected");
			return;
		}
		const entry = { ws, machineId: machine.id, lastSeen: Date.now(), pingTimer: null };
		this.agents.set(machine.id, entry);
		this.store.touch(machine.id, { status: "online", os: machine.os, arch: machine.arch });
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
		if (!issued && machine.device_expires_at) {
			const remaining = Date.parse(machine.device_expires_at) - Date.now();
			if (remaining < RENEW_BEFORE_MS) issued = this.store.rotateDevice(machine.id);
		}
		const payload = {
			type: "hello_ok",
			machine_id: machine.id,
			name: machine.name,
			expires_at: machine.device_expires_at,
			time: nowISO(),
		};
		if (issued) payload.device_token = issued.token;
		this.send(machine.id, payload);
	}

	attachPairing(ws, pairing) {
		const entry = { ws, pairingId: pairing.id, lastSeen: Date.now(), timer: null };
		this.pairingAgents.add(entry);
		const cleanup = () => {
			if (entry.timer) clearTimeout(entry.timer);
			this.pairingAgents.delete(entry);
		};
		entry.timer = setTimeout(() => {
			try {
				ws.close(4002, "pairing hello timeout");
			} catch {}
			cleanup();
		}, 30_000);
		ws.on("close", cleanup);
		ws.once("message", (data) => {
			cleanup();
			ws.off("close", cleanup);
			let msg;
			try {
				msg = JSON.parse(String(data));
			} catch {
				ws.close(1007, "invalid JSON");
				return;
			}
			if (msg.type !== "hello") {
				ws.close(4002, "hello required");
				return;
			}
			if (pairing.used_at) {
				ws.close(4003, "pairing already used");
				return;
			}
			const { machine, token, expires } = this.store.createDeviceForPairing(pairing, msg);
			this.attachDevice(ws, { ...machine, device_expires_at: expires }, { token });
		});
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
			case "session_opened":
			case "session_result":
			case "session_closed":
			case "session_error": {
				const pending = this.pending.get(msg.id);
				if (!pending) break;
				clearTimeout(pending.timer);
				this.pending.delete(msg.id);
				if (msg.type === "session_error") {
					pending.reject(new Error(msg.error || "session error"));
				} else {
					pending.resolve(msg);
				}
				break;
			}
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
		for (const [sessionId, owner] of this.sessions) {
			if (owner === machineId) this.sessions.delete(sessionId);
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
				...(m.device_expires_at ? { expires_at: m.device_expires_at } : {}),
				...(live
					? { last_seen: new Date(live.lastSeen).toISOString() }
					: m.last_seen
						? { last_seen: m.last_seen }
						: {}),
			};
		});
	}

	async exec(machineId, command, timeoutMs = 60_000, shell = "") {
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
				shell: shell || "",
				timeout_seconds: Math.ceil(timeout / 1000),
			});
			if (!ok) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`failed to send command to ${machineId}`));
			}
		});
	}

	request(machineId, payload, timeoutMs = 20_000) {
		const entry = this.agents.get(machineId);
		if (!entry || entry.ws.readyState !== 1) throw new Error(`machine ${machineId} is offline`);
		const id = randomUUID();
		const timeout = Math.max(1_000, Math.min(3_600_000, Number(timeoutMs) || 20_000));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`request timed out after ${timeout} ms`));
			}, timeout);
			this.pending.set(id, { resolve, reject, timer, machineId });
			if (!this.send(machineId, { ...payload, id })) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`failed to send request to ${machineId}`));
			}
		});
	}

	async sessionOpen(machineId, shell = "", cwd = "") {
		const sessionId = randomUUID();
		const result = await this.request(
			machineId,
			{ type: "session_open", session_id: sessionId, shell, cwd },
			20_000,
		);
		this.sessions.set(sessionId, machineId);
		return {
			sessionId,
			shell: result.shell || shell || "",
			cwd: result.cwd || cwd || "",
		};
	}

	async sessionExec(sessionId, command, timeoutMs = 60_000) {
		const machineId = this.sessions.get(sessionId);
		if (!machineId) throw new Error(`session not found: ${sessionId}`);
		const timeout = Math.max(1_000, Math.min(3_600_000, Number(timeoutMs) || 60_000));
		let result;
		try {
			result = await this.request(
				machineId,
				{
					type: "session_exec",
					session_id: sessionId,
					command,
					timeout_seconds: Math.ceil(timeout / 1000),
				},
				timeout + 5_000,
			);
		} catch (error) {
			// A timeout, dead shell or protocol error invalidates the session.
			this.sessions.delete(sessionId);
			throw error;
		}
		if (result.timed_out) this.sessions.delete(sessionId);
		return {
			sessionId,
			exitCode: Number(result.exit_code ?? -1),
			stdout: String(result.stdout ?? ""),
			stderr: String(result.stderr ?? ""),
			cwd: String(result.cwd ?? ""),
			truncated: Boolean(result.truncated),
			timedOut: Boolean(result.timed_out),
			durationMs: Number(result.duration_ms ?? 0),
		};
	}

	async sessionClose(sessionId) {
		const machineId = this.sessions.get(sessionId);
		if (!machineId) return { ok: true };
		try {
			await this.request(machineId, { type: "session_close", session_id: sessionId }, 10_000);
		} finally {
			this.sessions.delete(sessionId);
		}
		return { ok: true };
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
		for (const entry of this.pairingAgents) {
			if (entry.timer) clearTimeout(entry.timer);
			try {
				entry.ws.close(1001, "server shutting down");
			} catch {}
		}
		this.pairingAgents.clear();
		this.sessions.clear();
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

function requestHost(req) {
	const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1");
	return hostHeader.replace(/:[0-9]+$/, "").replace(/^\[|\]$/g, "");
}

function pairingBase(req) {
	const preset = currentPreset();
	if (preset?.url) return preset.url;
	const proto = process.env.REMOTE_SHELL_AGENT_TLS === "1" ? "wss" : "ws";
	return `${proto}://${requestHost(req)}:${AGENT_PORT}${AGENT_PATH}`;
}

function pairingLink(req, secret) {
	return `${pairingBase(req)}#${secret}`;
}

function agentCommand(link) {
	return `remote-agent --pair "${link}"`;
}

export function apply(ctx) {
	const store = new MachineStore();
	const hub = new MachineHub(store);
	const wss = new WebSocketServer({ noServer: true });

	const authorize = (req) => {
		const header = String(req.headers.authorization || "");
		const match = /^Bearer\s+(.+)$/i.exec(header);
		if (!match) return null;
		const machineId = String(req.headers["x-machine-id"] || "");
		if (machineId) {
			const machine = store.get(machineId);
			if (!machine || !store.verifyDevice(machineId, match[1])) return null;
			return { kind: "device", machine };
		}
		const pairing = store.findPairingBySecret(match[1]);
		if (!pairing) return null;
		return { kind: "pairing", pairing };
	};

	// The DSH web port is behind lanmode password auth, which also gates
	// WebSocket upgrades. Keep the agent listener on its own port, like the
	// browser-skill daemon, and authenticate every agent with its own token.
	const agentServer = http.createServer((_req, res) => {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
	});
	agentServer.on("upgrade", (req, socket, head) => {
		const auth = authorize(req);
		if (!auth) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (auth.kind === "pairing") hub.attachPairing(ws, auth.pairing);
			else hub.attachDevice(ws, auth.machine);
		});
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
				path: `${BASE}/config`,
				handler: async (req, res) => {
					if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
					const cfg = loadConfig();
					return sendJson(res, 200, {
						ok: true,
						presets: cfg.presets,
						currentId: cfg.currentId,
						currentUrl: currentPreset(cfg)?.url || "",
						agentPort: AGENT_PORT,
						effective: pairingBase(req),
					});
				},
			}),
		"remote-shell: link presets read",
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: `${BASE}/presets`,
				handler: async (req, res) => {
					const url = new URL(req.url || "/", "http://local");
					const rest = url.pathname.slice(`${BASE}/presets`.length).replace(/^\/+/, "");
					if (req.method === "POST" && rest === "") {
						const body = await readBody(req);
						if (body === null) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
						try {
							const label = normalizeLabel(body.label);
							const linkUrl = normalizePrefix(body.url);
							const cfg = loadConfig();
							const preset = { id: `l_${randomBytes(4).toString("hex")}`, label, url: linkUrl };
							cfg.presets.push(preset);
							if (!cfg.currentId) cfg.currentId = preset.id;
							saveConfig(cfg);
							return sendJson(res, 200, { ok: true, preset, currentId: cfg.currentId });
						} catch (error) {
							return sendJson(res, 400, { ok: false, error: error.message });
						}
					}
					if (req.method === "DELETE" && rest) {
						const cfg = loadConfig();
						const before = cfg.presets.length;
						cfg.presets = cfg.presets.filter((p) => p.id !== rest);
						if (cfg.presets.length === before) return sendJson(res, 404, { ok: false, error: "地址不存在" });
						if (cfg.currentId === rest) cfg.currentId = cfg.presets[0]?.id || "";
						saveConfig(cfg);
						return sendJson(res, 200, { ok: true, currentId: cfg.currentId });
					}
					return sendJson(res, 405, { ok: false, error: "method not allowed" });
				},
			}),
		"remote-shell: link presets write",
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: `${BASE}/switch`,
				handler: async (req, res) => {
					if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
					const body = await readBody(req);
					if (body === null) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
					const cfg = loadConfig();
					const preset = cfg.presets.find((p) => p.id === body.id);
					if (!preset) return sendJson(res, 404, { ok: false, error: "地址不存在" });
					cfg.currentId = preset.id;
					saveConfig(cfg);
					return sendJson(res, 200, { ok: true, currentId: cfg.currentId, switched: preset });
				},
			}),
		"remote-shell: switch link preset",
	);

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: `${BASE}/pairings`,
				handler: async (req, res) => {
					const url = new URL(req.url || "/", "http://local");
					const rest = url.pathname.slice(`${BASE}/pairings`.length).replace(/^\/+/, "");
					if (req.method === "GET" && rest === "") {
						return sendJson(res, 200, { ok: true, pairings: store.pendingPairings() });
					}
					if (req.method === "POST" && rest === "") {
						const body = await readBody(req);
						if (body === null) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
						const { pairing, secret } = store.createPairing(body.label);
						const link = pairingLink(req, secret);
						return sendJson(res, 200, { ok: true, pairing, link, command: agentCommand(link) });
					}
					if (req.method === "DELETE" && rest) {
						const ok = store.cancelPairing(rest);
						return sendJson(res, ok ? 200 : 404, { ok });
					}
					return sendJson(res, 405, { ok: false, error: "method not allowed" });
				},
			}),
		"remote-shell: pairing api",
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
					if (req.method === "PATCH" && rest) {
						const machine = store.get(rest);
						if (!machine) return sendJson(res, 404, { ok: false, error: "machine not found" });
						const body = await readBody(req);
						if (body === null) return sendJson(res, 400, { ok: false, error: "invalid JSON" });
						store.rename(machine.id, body.name);
						return sendJson(res, 200, { ok: true });
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
			description:
				"List machines registered with THIS remote-shell agent plugin (outbound agent, not the Server Deck SSH ledger). For SSH hosts use server_deck_hosts instead.",
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
									expires_at: { type: "string" },
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
			description:
				"Run one non-interactive command on a machine registered with THIS remote-shell agent plugin (outbound agent, not Server Deck SSH). Use server_deck_exec for Server Deck hosts. Each call starts a new shell; no persistent cwd/env.",
			parameters: {
				machine: { type: "string", required: true, description: "Machine id or exact name." },
				command: { type: "string", required: true, description: "Command to run." },
				shell: {
					type: "string",
					description: "cmd | powershell | pwsh on Windows; sh | bash on Unix. Omit for the platform default.",
				},
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
				const shell = String(args.shell || "").trim().toLowerCase();
				if (shell && !["cmd", "powershell", "pwsh", "sh", "bash"].includes(shell)) {
					throw new Error(`unsupported shell: ${shell}`);
				}
				const result = await hub.exec(machine.id, command, args.timeout_ms ?? 60_000, shell);
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

	ctx.tools.register(
		defineTool({
			name: "remote_session_open",
			description:
				"Open a persistent shell session on a remote-shell agent machine. Use remote_session_exec to run commands in it; use remote_exec for one-shot commands. This is not a Server Deck SSH host.",
			parameters: {
				machine: { type: "string", required: true, description: "Machine id or exact name." },
				shell: {
					type: "string",
					description: "Windows: powershell | pwsh. Unix: bash | sh. Omit for platform default.",
				},
				cwd: { type: "string", description: "Initial working directory." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						sessionId: { type: "string", required: true },
						shell: { type: "string", required: true },
						cwd: { type: "string", required: true },
					},
				},
				render: (_args, value) => [
					{ type: "text", text: `会话已打开：${value.sessionId} (${value.shell}) ${value.cwd}` },
				],
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				const machine = store.find(args.machine);
				if (!machine) throw new Error(`machine not found: ${args.machine}`);
				if (!hub.agents.has(machine.id)) throw new Error(`machine offline: ${machine.name} (${machine.id})`);
				return await hub.sessionOpen(machine.id, String(args.shell || ""), String(args.cwd || ""));
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "remote_session_exec",
			description:
				"Run one command in a persistent remote-shell session. Returns structured stdout/stderr/exit_code/cwd; shell state (cd, variables) persists across calls.",
			parameters: {
				session_id: { type: "string", required: true, description: "Session id returned by remote_session_open." },
				command: { type: "string", required: true, description: "Command to run." },
				timeout_ms: { type: "integer", description: "Timeout in ms (1000-3600000), default 60000." },
			},
			timeoutMs: 3_700_000,
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						sessionId: { type: "string", required: true },
						exitCode: { type: "integer", required: true },
						stdout: { type: "string", required: true },
						stderr: { type: "string", required: true },
						cwd: { type: "string", required: true },
						truncated: { type: "boolean", required: true },
						timedOut: { type: "boolean", required: true },
						durationMs: { type: "number", required: true },
					},
				},
				render: (_args, value) => {
					const head = `session ${value.sessionId} exit ${value.exitCode}${value.timedOut ? " timed out" : ""}`;
					const body = [value.stdout, value.stderr].filter((s) => s.length > 0).join("\n");
					return [{ type: "text", text: body.length > 0 ? `${head}\n${body}` : head }];
				},
			},
			isConcurrencySafe: () => false,
			async execute(args) {
				const command = String(args.command || "").trim();
				if (!command) throw new Error("command 不能为空");
				return await hub.sessionExec(String(args.session_id || ""), command, args.timeout_ms ?? 60_000);
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "remote_session_close",
			description: "Close a persistent remote-shell session and release its process.",
			parameters: {
				session_id: { type: "string", required: true, description: "Session id returned by remote_session_open." },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: { type: "boolean", required: true } },
				},
				render: () => [{ type: "text", text: "会话已关闭" }],
			},
			isConcurrencySafe: () => true,
			async execute(args) {
				return await hub.sessionClose(String(args.session_id || ""));
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
