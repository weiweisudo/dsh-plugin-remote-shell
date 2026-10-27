import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const CHUNK = 64 * 1024;
const WINDOW = 8 * 1024 * 1024;
const ACK_BYTES = 1 * 1024 * 1024;
const HEADER = 32;
const MAGIC = "JZ1";

function nowISO() {
	return new Date().toISOString();
}

function randomTransferID() {
	return `t_${randomBytes(16).toString("hex")}`;
}

function rawID(id) {
	return Buffer.from(String(id).replace(/^t_/, ""), "hex");
}

function buildFrame(id, offset, payload) {
	const header = Buffer.alloc(HEADER);
	header.write(MAGIC, 0, 3, "ascii");
	header[3] = 1;
	rawID(id).copy(header, 4);
	header.writeBigUInt64LE(BigInt(offset), 20);
	header.writeUInt32LE(payload.length, 28);
	return Buffer.concat([header, payload]);
}

function parseFrame(data) {
	if (data.length < HEADER || data.toString("ascii", 0, 3) !== MAGIC || data[3] !== 1) return null;
	const id = `t_${data.subarray(4, 20).toString("hex")}`;
	const offset = Number(data.readBigUInt64LE(20));
	const n = data.readUInt32LE(28);
	if (n < 0 || HEADER + n > data.length) return null;
	return { id, offset, payload: data.subarray(HEADER, HEADER + n) };
}

async function hashFile(path) {
	const hash = createHash("sha256");
	await new Promise((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolvePromise);
	});
	return hash.digest("hex");
}

export class TransferManager {
	constructor({ sendJSON, sendBinary, stateDir, workspace }) {
		this.sendJSON = sendJSON;
		this.sendBinary = sendBinary;
		this.stateDir = stateDir;
		this.workspace = workspace || process.cwd();
		this.transfers = new Map();
		this.closed = false;
	}

	async put(machineId, localPath, remotePath = "", overwrite = false, resume = true) {
		const source = this.resolveLocal(localPath);
		const fi = await stat(source);
		if (!fi.isFile()) throw new Error("local_path is not a file");
		const t = this.create(machineId, "upload", source, remotePath || basename(source), fi.size, overwrite, resume);
		this.emit(t);
		void this.prepareUpload(t);
		return this.snapshot(t);
	}

	async get(machineId, remotePath, localPath = "", overwrite = false, resume = true) {
		const target = this.resolveLocal(localPath || basename(remotePath));
		const t = this.create(machineId, "download", target, remotePath, 0, overwrite, resume);
		t.status = "preparing";
		this.emit(t);
		this.sendJSON(machineId, {
			type: "file_request",
			transfer_id: t.id,
			direction: "download",
			path: remotePath,
			resume,
		});
		return this.snapshot(t);
	}

	create(machineId, direction, localPath, remotePath, size, overwrite, resume) {
		const t = {
			id: randomTransferID(),
			machineId,
			direction,
			localPath,
			remotePath,
			size,
			sha256: "",
			overwrite: Boolean(overwrite),
			resume: resume !== false,
			status: "preparing",
			bytesDone: 0,
			acked: 0,
			attempt: 0,
			error: "",
			createdAt: nowISO(),
			updatedAt: nowISO(),
			fd: null,
			waiter: null,
		};
		this.transfers.set(t.id, t);
		return t;
	}

	resolveLocal(path) {
		if (!path) throw new Error("path is required");
		if (isAbsolute(path)) return path;
		return resolve(this.workspace, path);
	}

	async prepareUpload(t) {
		try {
			t.sha256 = await hashFile(t.localPath);
			if (this.closed || t.status === "canceled") return;
			t.status = "queued";
			this.emit(t);
			this.sendJSON(t.machineId, {
				type: "file_begin",
				transfer_id: t.id,
				direction: "upload",
				path: t.remotePath,
				size: t.size,
				sha256: t.sha256,
				overwrite: t.overwrite ?? false,
				resume: true,
			});
		} catch (error) {
			this.fail(t, error.message || "io_error");
		}
	}

	async handleJSON(machineId, msg) {
		const t = msg.transfer_id ? this.transfers.get(msg.transfer_id) : null;
		switch (msg.type) {
			case "file_ready":
				if (t && t.direction === "upload") {
					if (t.status === "canceled") {
						this.sendJSON(t.machineId, { type: "file_abort", transfer_id: t.id });
						break;
					}
					t.offset = Number(msg.offset || 0);
					t.acked = t.offset;
					t.bytesDone = t.offset;
					t.status = "running";
					this.emit(t);
					void this.sendUpload(t);
				}
				break;
			case "file_offer":
				if (t && t.direction === "download") await this.acceptOffer(t, msg);
				break;
			case "file_ack":
				if (t && t.direction === "upload") {
					t.acked = Math.max(t.acked, Number(msg.offset || 0));
					this.wake(t);
				}
				break;
			case "file_end":
				if (t && t.direction === "download") {
					t.endSeen = true;
					t.endMsg = msg;
					if (t.offset >= t.size) await this.finishDownload(t, msg);
				}
				break;
			case "file_result":
				if (t && t.direction === "upload") {
					if (msg.ok) this.complete(t);
					else this.fail(t, msg.error || "io_error");
				}
				break;
			case "file_error":
				if (t) this.fail(t, msg.error || "io_error");
				break;
			case "file_status":
				if (t) {
					t.status = msg.status || t.status;
					t.bytesDone = Number(msg.offset ?? t.bytesDone);
					t.error = msg.error || t.error;
					this.emit(t);
				}
				break;
		}
	}

	async acceptOffer(t, msg) {
		if (t.status === "canceled") return;
		try {
			const sourceSize = Number(msg.size || 0);
			const sha = String(msg.sha256 || "");
			t.size = sourceSize;
			t.sha256 = sha;
			t.remotePath = msg.path || t.remotePath;
			await mkdir(dirname(t.localPath), { recursive: true });
			const part = `${t.localPath}.part`;
			const metaPath = `${part}.meta`;
			let offset = 0;
			try {
				const meta = JSON.parse(await readFile(metaPath, "utf8"));
				const fi = await stat(part);
				if (
					t.resume !== false &&
					meta.transfer_id === t.id &&
					meta.path === t.localPath &&
					Number(meta.size) === sourceSize &&
					meta.sha256 === sha &&
					fi.size <= sourceSize
				) {
					offset = fi.size;
				}
			} catch {}
			if (offset === 0) {
				await rm(part, { force: true });
				await rm(metaPath, { force: true });
			}
			await writeFile(
				metaPath,
				JSON.stringify({ transfer_id: t.id, path: t.localPath, size: sourceSize, sha256: sha, updated_at: nowISO() }),
				{ mode: 0o600 },
			);
			t.fd = await open(part, "r+").catch(async () => {
				const fh = await open(part, "w+");
				return fh;
			});
			t.offset = offset;
			t.acked = offset;
			t.bytesDone = offset;
			t.status = "running";
			t.remoteReady = true;
			this.emit(t);
			this.sendJSON(t.machineId, { type: "file_ready", transfer_id: t.id, offset });
		} catch (error) {
			this.sendJSON(t.machineId, { type: "file_abort", transfer_id: t.id });
			this.fail(t, error.message || "io_error");
		}
	}

	async sendUpload(t) {
		let fh;
		try {
			fh = await open(t.localPath, "r");
			let offset = Number(t.offset || 0);
			while (offset < t.size && !this.closed && t.status === "running") {
				while (offset - t.acked > WINDOW && t.status === "running") await this.wait(t, 50);
				const len = Math.min(CHUNK, t.size - offset);
				const buf = Buffer.alloc(len);
				const { bytesRead } = await fh.read(buf, 0, len, offset);
				if (bytesRead <= 0) break;
				await this.sendBinary(t.machineId, buildFrame(t.id, offset, buf.subarray(0, bytesRead)));
				offset += bytesRead;
				t.bytesDone = offset;
				this.emit(t, true);
			}
			if (t.status === "running") {
				t.status = "verifying";
				this.emit(t);
				this.sendJSON(t.machineId, { type: "file_end", transfer_id: t.id, sha256: t.sha256 });
			}
		} catch (error) {
			this.fail(t, error.message || "io_error");
		} finally {
			if (fh) await fh.close();
		}
	}

	handleBinary(machineId, data) {
		const frame = parseFrame(data);
		if (!frame) return;
		const t = this.transfers.get(frame.id);
		if (!t || t.direction !== "download" || !t.fd) return;
		// WebSocket messages can arrive faster than async file writes; serialize per transfer.
		t.chain = (t.chain || Promise.resolve())
			.then(() => this.applyChunk(machineId, t, frame))
			.catch((error) => this.fail(t, error.message || "io_error"));
		return t.chain;
	}

	async applyChunk(machineId, t, frame) {
		if (["canceled", "failed"].includes(t.status)) return;
		if (frame.offset !== t.offset) {
			this.fail(t, "offset_mismatch");
			return;
		}
		await t.fd.write(frame.payload, 0, frame.payload.length, frame.offset);
		t.offset += frame.payload.length;
		t.bytesDone = t.offset;
		if (t.endSeen && t.offset >= t.size) {
			this.finishDownload(t, t.endMsg).catch((error) => this.fail(t, error.message || "io_error"));
		}
		if (t.offset - t.acked >= ACK_BYTES) {
			t.acked = t.offset;
			this.sendJSON(machineId, { type: "file_ack", transfer_id: t.id, offset: t.acked });
		}
		this.emit(t, true);
	}

	async finishDownload(t, msg) {
		if (t.finalized) return;
		t.finalized = true;
		try {
			const part = `${t.localPath}.part`;
			const metaPath = `${part}.meta`;
			if (t.fd) {
				await t.fd.close();
				t.fd = null;
			}
			const fi = await stat(part);
			if (fi.size !== t.size) throw new Error("size_mismatch");
			const got = await hashFile(part);
			if (got !== t.sha256) throw new Error("sha256_mismatch");
			try {
				if (!t.overwrite) await stat(t.localPath).then(() => { throw new Error("exists"); });
			} catch (error) {
				if (error.message === "exists") throw error;
			}
			await rename(part, t.localPath);
			await rm(metaPath, { force: true });
			t.status = "completed";
			t.bytesDone = t.size;
			this.sendJSON(t.machineId, { type: "file_result", transfer_id: t.id, ok: true, path: t.localPath, size: t.size });
			this.emit(t);
		} catch (error) {
			this.sendJSON(t.machineId, { type: "file_result", transfer_id: t.id, ok: false, error: error.message || "io_error" });
			this.fail(t, error.message || "io_error");
		}
	}

	async retry(id) {
		const t = this.transfers.get(id);
		if (!t) throw new Error(`transfer not found: ${id}`);
		if (t.status === "completed") return this.snapshot(t);
		t.error = "";
		t.status = "preparing";
		this.emit(t);
		if (t.direction === "upload") {
			void this.prepareUpload(t);
		} else {
			this.sendJSON(t.machineId, {
				type: "file_request",
				transfer_id: t.id,
				direction: "download",
				path: t.remotePath,
				resume: true,
			});
		}
		return this.snapshot(t);
	}

	async cancel(id) {
		const t = this.transfers.get(id);
		if (!t) throw new Error(`transfer not found: ${id}`);
		if (t.status === "completed" || t.status === "canceled") return this.snapshot(t);
		t.status = "canceled";
		if (t.fd) {
			await t.fd.close();
			t.fd = null;
		}
		await rm(`${t.localPath}.part`, { force: true });
		await rm(`${t.localPath}.part.meta`, { force: true });
		this.sendJSON(t.machineId, { type: "file_abort", transfer_id: t.id });
		this.emit(t);
		return this.snapshot(t);
	}

	async status(id, waitMs = 0) {
		const t = this.transfers.get(id);
		if (!t) throw new Error(`transfer not found: ${id}`);
		await this.wait(t, Math.min(30000, Math.max(0, Number(waitMs) || 0)));
		return this.snapshot(t);
	}

	list(machineId = "") {
		return [...this.transfers.values()]
			.filter((t) => !machineId || t.machineId === machineId)
			.map((t) => this.snapshot(t));
	}

	snapshot(t) {
		const elapsed = Math.max(0.001, (Date.now() - Date.parse(t.createdAt)) / 1000);
		return {
			transferId: t.id,
			machineId: t.machineId,
			direction: t.direction,
			localPath: t.localPath,
			remotePath: t.remotePath,
			size: t.size,
			sha256: t.sha256,
			status: t.status,
			bytesDone: t.bytesDone,
			speed: Math.round(t.bytesDone / elapsed),
			etaSeconds: t.size > t.bytesDone && t.bytesDone > 0 ? Math.ceil((t.size - t.bytesDone) / Math.max(1, t.bytesDone / elapsed)) : 0,
			attempt: t.attempt || 0,
			error: t.error || "",
			createdAt: t.createdAt,
			updatedAt: t.updatedAt,
		};
	}

	complete(t) {
		t.status = "completed";
		t.bytesDone = t.size;
		t.updatedAt = nowISO();
		this.emit(t);
	}

	fail(t, reason) {
		if (["completed", "canceled"].includes(t.status)) return;
		t.status = "failed";
		t.error = String(reason || "io_error");
		t.updatedAt = nowISO();
		if (t.fd) {
			void t.fd.close().catch(() => {});
			t.fd = null;
		}
		void rm(`${t.localPath}.part`, { force: true }).catch(() => {});
		void rm(`${t.localPath}.part.meta`, { force: true }).catch(() => {});
		this.emit(t);
	}

	wake(t) {
		if (t.waiter) {
			const w = t.waiter;
			t.waiter = null;
			w();
		}
	}

	wait(t, ms) {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolvePromise) => {
			const timer = setTimeout(() => {
				t.waiter = null;
				resolvePromise();
			}, ms);
			t.waiter = () => {
				clearTimeout(timer);
				resolvePromise();
			};
		});
	}

	emit(t, throttle = false) {
		t.updatedAt = nowISO();
		if (!throttle || Date.now() - (t.lastEmit || 0) > 1000) {
			t.lastEmit = Date.now();
			this.wake(t);
		}
	}

	detach(machineId) {
		for (const t of this.transfers.values()) {
			if (t.machineId !== machineId) continue;
			if (["running", "queued", "preparing", "waiting_ready"].includes(t.status)) {
				t.status = "paused";
				if (t.fd) {
					void t.fd.close().catch(() => {});
					t.fd = null;
				}
				this.emit(t);
			}
		}
	}

	close() {
		this.closed = true;
		for (const t of this.transfers.values()) {
			if (t.status === "running" || t.status === "queued" || t.status === "preparing") {
				t.status = "paused";
				if (t.fd) {
					void t.fd.close().catch(() => {});
					t.fd = null;
				}
			}
		}
	}
}
