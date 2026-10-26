// dsh-plugin-remote-shell — client 半（P0.5：配对链接 + 自动注册）
window.__ModuleLoader__.load({
	id: "dsh-plugin-remote-shell",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const { useCallback, useEffect, useMemo, useState } = React;

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

		// DSH publishes the resolved palette on <body data-ds-dark-theme>.
		// Observing that attribute follows both the light/dark switch and the
		// "system" preference without duplicating DSH's theme resolution.
		function useDshDark() {
			const [dark, setDark] = useState(() => document.body.hasAttribute("data-ds-dark-theme"));
			useEffect(() => {
				const body = document.body;
				const observer = new MutationObserver(() => setDark(body.hasAttribute("data-ds-dark-theme")));
				observer.observe(body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
				return () => observer.disconnect();
			}, []);
			return dark;
		}

		const LIGHT = {
			border: "#d0d7de",
			borderSoft: "#e6e9ed",
			bg: "#ffffff",
			inputBg: "#ffffff",
			buttonBg: "#f6f8fa",
			text: "#1f2328",
			muted: "#57606a",
			accent: "#0969da",
			accentText: "#ffffff",
			online: "#1a7f37",
			offline: "#57606a",
			warning: "#9a6700",
			danger: "#cf222e",
			codeBg: "#f6f8fa",
		};
		const DARK = {
			border: "#30363d",
			borderSoft: "#21262d",
			bg: "#161b22",
			inputBg: "#0d1117",
			buttonBg: "#21262d",
			text: "#e6edf3",
			muted: "#8b949e",
			accent: "#2f81f7",
			accentText: "#ffffff",
			online: "#3fb950",
			offline: "#8b949e",
			warning: "#d29922",
			danger: "#f85149",
			codeBg: "#0d1117",
		};

		function styles(p) {
			return {
				root: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 900, color: p.text },
				card: { border: `1px solid ${p.border}`, borderRadius: 10, padding: "14px 16px", background: p.bg },
				head: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
				title: { fontSize: 14, fontWeight: 600 },
				sub: { fontSize: 12, color: p.muted, marginLeft: "auto" },
				row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
				input: {
					background: p.inputBg,
					color: p.text,
					border: `1px solid ${p.border}`,
					borderRadius: 6,
					padding: "6px 8px",
					fontSize: 13,
					minWidth: 200,
				},
				button: {
					border: `1px solid ${p.border}`,
					borderRadius: 6,
					padding: "6px 12px",
					fontSize: 13,
					cursor: "pointer",
					background: p.buttonBg,
					color: p.text,
				},
				primary: { background: p.accent, borderColor: p.accent, color: p.accentText },
				danger: { color: p.danger, borderColor: p.border, background: "transparent" },
				note: { fontSize: 12, color: p.muted, lineHeight: 1.6 },
				badge: { fontSize: 11, padding: "1px 7px", borderRadius: 999, border: `1px solid ${p.border}`, color: p.muted },
				code: {
					display: "block",
					background: p.codeBg,
					border: `1px solid ${p.border}`,
					borderRadius: 6,
					padding: "9px 10px",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
					fontSize: 12,
					whiteSpace: "pre-wrap",
					wordBreak: "break-all",
					color: p.text,
				},
				table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
				th: { textAlign: "left", padding: "5px 6px", borderBottom: `1px solid ${p.border}`, color: p.muted, fontWeight: 500 },
				td: { padding: "6px", borderBottom: `1px solid ${p.borderSoft}` },
				dot: { display: "inline-block", width: 7, height: 7, borderRadius: "50%", marginRight: 5 },
			};
		}

		function fmt(iso) {
			if (!iso) return "—";
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return "—";
			return d.toLocaleString();
		}

		function remaining(iso) {
			const ms = Date.parse(iso) - Date.now();
			if (!Number.isFinite(ms) || ms <= 0) return "已过期";
			const sec = Math.floor(ms / 1000);
			return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
		}

		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				try {
					const el = document.createElement("textarea");
					el.value = text;
					el.style.position = "fixed";
					el.style.opacity = "0";
					document.body.appendChild(el);
					el.select();
					document.execCommand("copy");
					el.remove();
					return true;
				} catch {
					return false;
				}
			}
		}

		function RemoteShellSettings() {
			const dark = useDshDark();
			const p = dark ? DARK : LIGHT;
			const S = useMemo(() => styles(p), [dark]);
			const [machines, setMachines] = useState([]);
			const [pairings, setPairings] = useState([]);
			const [profileName, setProfileName] = useState("");
			const [publicUrl, setPublicUrl] = useState("");
			const [prefixMsg, setPrefixMsg] = useState("");
			const [label, setLabel] = useState("");
			const [created, setCreated] = useState(null);
			const [busy, setBusy] = useState("");
			const [message, setMessage] = useState("");
			const [now, setNow] = useState(Date.now());

			const load = useCallback(async () => {
				const [m, q] = await Promise.all([request("/machines"), request("/pairings")]);
				if (m?.ok && Array.isArray(m.machines)) setMachines(m.machines);
				if (q?.ok && Array.isArray(q.pairings)) setPairings(q.pairings);
			}, []);

			// Load the editable config once. Polling it would overwrite whatever
			// the user is typing every few seconds.
			useEffect(() => {
				let alive = true;
				request("/config").then((c) => {
					if (!alive || !c?.ok) return;
					if (typeof c.name === "string") setProfileName(c.name);
					if (typeof c.publicUrl === "string") setPublicUrl(c.publicUrl);
				});
				return () => {
					alive = false;
				};
			}, []);

			useEffect(() => {
				load();
				const poll = setInterval(load, 3000);
				const tick = setInterval(() => setNow(Date.now()), 1000);
				return () => {
					clearInterval(poll);
					clearInterval(tick);
				};
			}, [load]);

			async function savePrefix() {
				setPrefixMsg("");
				const res = await request("/config", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: profileName.trim(), publicUrl: publicUrl.trim() }),
				});
				if (res?.ok) {
					setProfileName(res.name || "");
					setPublicUrl(res.publicUrl || "");
					setPrefixMsg(res.publicUrl ? "入口已保存" : "已恢复自动入口");
					setTimeout(() => setPrefixMsg(""), 2500);
				} else setPrefixMsg(res?.error || "保存失败");
			}

			async function createPairing() {
				setBusy("create");
				setMessage("");
				const res = await request("/pairings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ label: label.trim() }),
				});
				setBusy("");
				if (res?.ok) {
					setCreated(res);
					setLabel("");
					load();
				} else setMessage(res?.error || "生成失败");
			}

			async function cancelPairing(id) {
				setBusy(`cancel:${id}`);
				const res = await request(`/pairings/${encodeURIComponent(id)}`, { method: "DELETE" });
				setBusy("");
				if (res?.ok) {
					setCreated((prev) => (prev?.pairing?.id === id ? null : prev));
					load();
				} else setMessage(res?.error || "取消失败");
			}

			async function removeMachine(id) {
				if (!window.confirm("撤销这台机器的授权？agent 会立即断开，且无法再用旧凭证重连。")) return;
				setBusy(`delete:${id}`);
				const res = await request(`/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
				setBusy("");
				if (res?.ok) load();
				else setMessage(res?.error || "撤销失败");
			}

			async function copy(value, what) {
				const ok = await copyText(value);
				setMessage(ok ? `${what}已复制` : "复制失败，请手动选择");
				setTimeout(() => setMessage(""), 2500);
			}

			const pending = pairings.filter((x) => !created || x.id !== created.pairing.id);

			return h(
				"div",
				{ style: S.root },
				h(
					"div",
					{ style: S.card },
					h(
						"div",
						{ style: S.head },
						h("div", { style: S.title }, "远程机器"),
						h("div", { style: S.sub }, `${machines.filter((m) => m.status === "online").length} 在线 / ${machines.length} 已授权`),
					),
					h(
						"div",
						{ style: S.note },
						"生成一次性连接链接，在目标机运行 agent；连上后自动出现在下方，无需先创建机器。",
					),
					h(
						"div",
						{ style: { ...S.row, marginTop: 12 } },
						h("input", {
							style: S.input,
							placeholder: "备注名（可选），例如 Windows PC",
							value: label,
							onChange: (e) => setLabel(e.target.value),
							onKeyDown: (e) => {
								if (e.key === "Enter" && !busy) createPairing();
							},
						}),
						h(
							"button",
							{ style: { ...S.button, ...S.primary }, onClick: createPairing, disabled: busy !== "" },
							busy === "create" ? "生成中…" : "生成连接链接",
						),
						message ? h("span", { style: S.badge }, message) : null,
					),
					created
						? h(
								"div",
								{ style: { marginTop: 14, display: "flex", flexDirection: "column", gap: 8 } },
								h(
									"div",
									{ style: { ...S.row, justifyContent: "space-between" } },
									h("div", { style: { ...S.note, color: p.warning } }, "链接 5 分钟内有效，仅可使用一次"),
									h("div", { style: S.badge }, remaining(created.pairing.expires_at)),
								),
								h("code", { style: S.code }, created.link),
								h(
									"div",
									{ style: S.row },
									h("button", { style: S.button, onClick: () => copy(created.link, "链接") }, "复制链接"),
									h("button", { style: S.button, onClick: () => copy(created.command, "命令") }, "复制命令"),
									h(
										"button",
										{ style: { ...S.button, ...S.danger }, onClick: () => cancelPairing(created.pairing.id) },
										"取消",
									),
								),
								h("code", { style: S.code }, created.command),
								h(
									"div",
									{ style: S.note },
									"agent 首次连接后会保存 180 天设备凭证；之后重启不再需要链接。",
								),
							)
						: null,
					pending.length > 0
						? h(
								"div",
								{ style: { marginTop: 12 } },
								h("div", { style: { ...S.note, marginBottom: 4 } }, "等待连接"),
								pending.map((x) =>
									h(
										"div",
										{ key: x.id, style: { ...S.row, padding: "4px 0" } },
										h("span", { style: S.badge }, x.label || x.id),
										h("span", { style: S.note }, `剩余 ${remaining(x.expires_at)}`),
										h(
											"button",
											{ style: { ...S.button, ...S.danger, padding: "2px 8px", fontSize: 12 }, onClick: () => cancelPairing(x.id) },
											"取消",
										),
									),
								),
							)
						: null,
				),

				h(
					"div",
					{ style: S.card },
					h("div", { style: S.head }, h("div", { style: S.title }, "链接入口")),
					h(
						"div",
						{ style: S.note },
						"生成配对链接时使用。名称用于标识入口，前缀是 Lucky / Cloudflare 的完整 WebSocket 地址；留空前缀则自动使用当前访问地址 + 47777。",
					),
					h(
						"div",
						{ style: { ...S.row, marginTop: 10 } },
						h("input", {
							style: { ...S.input, minWidth: 150, flex: "0 1 180px" },
							placeholder: "名称，例如 IPv6 直连",
							value: profileName,
							onChange: (e) => setProfileName(e.target.value),
						}),
						h("input", {
							style: { ...S.input, minWidth: 420, flex: 1 },
							placeholder: "wss://agent6.potatooo.top:777/api/remote-shell/agent",
							value: publicUrl,
							onChange: (e) => setPublicUrl(e.target.value),
						}),
						h("button", { style: S.button, onClick: savePrefix }, "保存"),
						prefixMsg ? h("span", { style: S.badge }, prefixMsg) : null,
					),
					h(
						"div",
						{ style: { ...S.note, marginTop: 6 } },
						publicUrl
							? `当前：${profileName ? profileName + " — " : ""}${publicUrl}`
							: "当前：自动（访问地址 + 47777）",
					),
				),

				h(
					"div",
					{ style: S.card },
					h("div", { style: S.head }, h("div", { style: S.title }, "已授权机器")),
					machines.length === 0
						? h("div", { style: S.note }, "还没有机器。生成连接链接并在目标机运行 agent 即可。")
						: h(
								"table",
								{ style: S.table },
								h(
									"thead",
									null,
									h(
										"tr",
										null,
										["名称", "ID", "状态", "系统", "凭证到期", "最后在线", ""].map((t) =>
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
												{ style: { ...S.td, color: m.status === "online" ? p.online : p.offline } },
												h("span", { style: { ...S.dot, background: m.status === "online" ? p.online : p.offline } }),
												m.status,
											),
											h("td", { style: S.td }, m.os ? `${m.os}/${m.arch}` : "—"),
											h("td", { style: S.td }, fmt(m.expires_at)),
											h("td", { style: S.td }, fmt(m.last_seen)),
											h(
												"td",
												{ style: S.td },
												h(
													"button",
													{
														style: { ...S.button, ...S.danger, padding: "3px 8px", fontSize: 12 },
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
					h("div", { style: S.head }, h("div", { style: S.title }, "使用方式")),
					h(
						"div",
						{ style: S.note },
						"Windows：下载 remote-agent.exe，托盘/服务模式粘贴链接。Linux：headless 运行 `remote-agent --pair <链接>`。",
					),
					h(
						"div",
						{ style: { ...S.note, marginTop: 6 } },
						"agent 通过出站 WebSocket 连接；目标机不需要 sshd/WinRM，也不监听端口。",
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
