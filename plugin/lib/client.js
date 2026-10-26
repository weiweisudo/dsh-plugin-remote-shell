// dsh-plugin-remote-shell — client 半（P0：机器台账）
window.__ModuleLoader__.load({
	id: "dsh-plugin-remote-shell",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const { useCallback, useEffect, useState } = React;

		const API = "/api/remote-shell";
		const h = React.createElement;

		async function request(path, init) {
			const response = await fetch(API + path, { cache: "no-store", ...(init || {}) });
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = { ok: false, error: `HTTP ${response.status}` };
			}
			return payload;
		}

		const S = {
			root: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 880 },
			card: { border: "1px solid var(--dsh-border, #2a3138)", borderRadius: 10, padding: "14px 16px" },
			title: { fontSize: 14, fontWeight: 600, marginBottom: 10 },
			row: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" },
			input: {
				background: "var(--dsh-input-bg, #171b1f)",
				color: "inherit",
				border: "1px solid var(--dsh-border, #2a3138)",
				borderRadius: 6,
				padding: "6px 8px",
				fontSize: 13,
			},
			button: {
				border: "1px solid var(--dsh-border, #2a3138)",
				borderRadius: 6,
				padding: "6px 12px",
				fontSize: 13,
				cursor: "pointer",
				background: "var(--dsh-button-bg, #1e242a)",
				color: "inherit",
			},
			primary: { background: "var(--dsh-accent, #2f6feb)", borderColor: "transparent", color: "#fff" },
			table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
			th: { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid var(--dsh-border, #2a3138)", opacity: 0.7 },
			td: { padding: "4px 6px", borderBottom: "1px solid var(--dsh-border, #232a31)" },
			note: { fontSize: 12, opacity: 0.65, lineHeight: 1.6 },
			badge: { fontSize: 11, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--dsh-border, #2a3138)" },
			code: {
				display: "block",
				background: "var(--dsh-input-bg, #171b1f)",
				border: "1px solid var(--dsh-border, #2a3138)",
				borderRadius: 6,
				padding: "8px",
				fontFamily: "monospace",
				fontSize: 12,
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
			},
		};

		function statusColor(status) {
			return status === "online" ? "#3fb950" : "#8b949e";
		}

		function RemoteShellSettings() {
			const [machines, setMachines] = useState([]);
			const [name, setName] = useState("");
			const [created, setCreated] = useState(null);
			const [busy, setBusy] = useState("");
			const [message, setMessage] = useState("");

			const load = useCallback(async () => {
				const res = await request("/machines");
				if (res?.ok && Array.isArray(res.machines)) setMachines(res.machines);
			}, []);

			useEffect(() => {
				load();
			}, [load]);

			async function createMachine() {
				setBusy("create");
				setMessage("");
				const res = await request("/machines", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: name.trim() }),
				});
				setBusy("");
				if (res?.ok) {
					setCreated(res);
					setName("");
					load();
				} else setMessage(res?.error || "创建失败");
			}

			async function removeMachine(id) {
				if (!window.confirm("撤销这台机器的授权？agent 会立即被断开。")) return;
				setBusy(`delete:${id}`);
				setMessage("");
				const res = await request(`/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
				setBusy("");
				if (res?.ok) {
					load();
					setCreated((prev) => (prev?.machine?.id === id ? null : prev));
				} else setMessage(res?.error || "撤销失败");
			}

			return h(
				"div",
				{ style: S.root },
				h(
					"div",
					{ style: S.card },
					h("div", { style: S.title }, "远程机器（P0）"),
					h(
						"div",
						{ style: { ...S.note, marginBottom: 8 } },
						"agent 主动出站连接 DSH 插件专用端口（默认 47777）；目标机不需要 sshd / WinRM，也不监听端口。P0 只提供非交互命令执行。",
					),
					h(
						"div",
						{ style: S.row },
						h("input", {
							style: { ...S.input, width: 220 },
							placeholder: "机器名称，例如 Windows PC",
							value: name,
							onChange: (e) => setName(e.target.value),
						}),
						h(
							"button",
							{ style: { ...S.button, ...S.primary }, onClick: createMachine, disabled: busy !== "" },
							busy === "create" ? "创建中…" : "创建机器",
						),
						h(
							"button",
							{ style: S.button, onClick: load, disabled: busy !== "" },
							"刷新",
						),
						message ? h("span", { style: { ...S.badge, opacity: 0.9 } }, message) : null,
					),
					created
						? h(
								"div",
								{ style: { marginTop: 10 } },
								h("div", { style: { ...S.note, color: "#d29922" } }, "token 只显示一次，请立即保存到目标机的 token.txt"),
								h("code", { style: S.code }, `machine_id: ${created.machine.id}\ntoken: ${created.token}\n\n${created.command}`),
							)
						: null,
				),

				h(
					"div",
					{ style: S.card },
					h("div", { style: S.title }, "已授权机器"),
					machines.length === 0
						? h("div", { style: S.note }, "还没有机器。先创建机器，再在目标机运行 agent。")
						: h(
								"table",
								{ style: S.table },
								h(
									"thead",
									null,
									h(
										"tr",
										null,
										["名称", "ID", "状态", "系统", "最后在线", ""].map((t) =>
											h("th", { key: t, style: S.th }, t),
										),
									),
								),
								h(
									"tbody",
									null,
									machines.map((m) =>
										h(
											"tr",
											{ key: m.id },
											h("td", { style: S.td }, m.name),
											h("td", { style: { ...S.td, fontFamily: "monospace" } }, m.id),
											h(
												"td",
												{ style: { ...S.td, color: statusColor(m.status) } },
												m.status,
											),
											h("td", { style: S.td }, m.os ? `${m.os}/${m.arch}` : "—"),
											h("td", { style: S.td }, m.last_seen ? String(m.last_seen).slice(0, 19).replace("T", " ") : "—"),
											h(
												"td",
												{ style: S.td },
												h(
													"button",
													{
														style: { ...S.button, padding: "3px 8px", fontSize: 12 },
														onClick: () => removeMachine(m.id),
														disabled: busy !== "",
													},
													"撤销",
												),
											),
										),
									),
								),
							),
				),

				h(
					"div",
					{ style: S.card },
					h("div", { style: S.title }, "agent 启动示例"),
					h(
						"div",
						{ style: S.note },
						"Windows 普通用户即可运行；Linux 用同一份 agent。token 文件权限建议 600。",
					),
					h(
						"code",
						{ style: S.code },
						[
							"# Windows (PowerShell)",
							".\\remote-agent-windows-amd64.exe --server ws://192.168.5.8:47777/api/remote-shell/agent --machine-id <id> --token-file token.txt",
							"",
							"# Linux",
							"./remote-agent-linux-amd64 --server ws://192.168.5.8:47777/api/remote-shell/agent --machine-id <id> --token-file token.txt",
						].join("\n"),
					),
				),
			);
		}

		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "remote-shell",
							order: 64,
							label: () => "远程机器",
						},
						RemoteShellSettings,
					),
				);
				console.info("[remote-shell] registered settings.section");
			} catch (error) {
				console.error("[remote-shell] settings.section registration failed", error);
			}
		}

		const inject = ["slots"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
