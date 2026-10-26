//go:build windows

package main

const desktopHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote Shell</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --card: #f6f8fa;
    --border: #d0d7de;
    --text: #1f2328;
    --muted: #57606a;
    --accent: #0969da;
    --accent-text: #ffffff;
    --ok: #1a7f37;
    --bad: #cf222e;
    --warn: #9a6700;
    --input: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #2f81f7;
      --accent-text: #ffffff;
      --ok: #3fb950;
      --bad: #f85149;
      --warn: #d29922;
      --input: #0d1117;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 0 0 10px; }
  .sub { color: var(--muted); margin: 0 0 22px; font-size: 12px; }
  section {
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 10px;
    padding: 16px;
    margin-top: 14px;
  }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .status { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--ok); }
  .dot.off { background: var(--bad); }
  .meta { color: var(--muted); font-size: 12px; word-break: break-all; }
  textarea {
    width: 100%;
    min-height: 74px;
    resize: vertical;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--input);
    color: var(--text);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  button {
    border: 1px solid var(--border);
    background: var(--input);
    color: var(--text);
    border-radius: 7px;
    padding: 7px 13px;
    font-size: 13px;
    cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button.danger { color: var(--bad); }
  button:disabled { opacity: .55; cursor: default; }
  .msg { min-height: 20px; font-size: 12px; color: var(--muted); margin-top: 8px; }
  .msg.bad { color: var(--bad); }
  .msg.ok { color: var(--ok); }
  .checkrow { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .checkrow input { width: 16px; height: 16px; }
  .warn { color: var(--warn); }
</style>
</head>
<body>
<main>
  <h1>DSH Remote Shell</h1>
  <p class="sub">本机 agent 主动出站连接 DSH；不需要 sshd、WinRM，也不监听入站端口。</p>

  <section>
    <h2>连接状态</h2>
    <div class="status"><span id="dot" class="dot"></span><strong id="state">读取中…</strong></div>
    <div class="meta" id="meta"></div>
    <div class="meta" id="err"></div>
  </section>

  <section>
    <h2>远程连接链接</h2>
    <div class="meta" style="margin-bottom:8px">在 DSH 插件「远程机器」里生成一次性链接，粘贴到这里。链接 5 分钟有效，只用一次。</div>
    <textarea id="link" placeholder="ws://192.168.5.8:47777/api/remote-shell/agent#..."></textarea>
    <div class="row" style="margin-top:8px">
      <button class="primary" id="pair">连接</button>
      <button id="reconnect">重新连接</button>
    </div>
    <div class="msg" id="pairMsg"></div>
  </section>

  <section>
    <h2>开机启动</h2>
    <label class="checkrow"><input type="checkbox" id="autostart"> 登录 Windows 后自动启动托盘</label>
    <div class="meta" style="margin-top:8px">只写当前用户的 HKCU Run，不需要管理员；比服务轻。若已安装服务，建议关闭此项，避免重复连接。</div>
    <div class="msg" id="autoMsg"></div>
  </section>

  <section>
    <h2>Windows 服务</h2>
    <div class="meta" id="serviceMeta">读取中…</div>
    <div class="row" style="margin-top:10px">
      <button id="install">安装为服务</button>
      <button class="danger" id="uninstall">解除服务</button>
    </div>
    <div class="meta" style="margin-top:8px">服务模式开机自启、无托盘，默认 LocalSystem，需要管理员权限。安装前请先完成一次配对。</div>
    <div class="msg" id="svcMsg"></div>
  </section>

  <section>
    <h2>退出</h2>
    <div class="meta" style="margin-bottom:8px">关闭浏览器不会退出；托盘继续运行。只有这里或托盘“退出”才会停止后台连接。</div>
    <button class="danger" id="quit">退出托盘</button>
  </section>
</main>
<script>
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get("token") || "";
  if (token) {
    document.cookie = "rs_token=" + encodeURIComponent(token) + "; path=/; SameSite=Strict";
    history.replaceState(null, "", location.pathname);
  }
  const $ = (id) => document.getElementById(id);
  function msg(el, text, cls) {
    el.textContent = text || "";
    el.className = "msg" + (cls ? " " + cls : "");
  }
  async function api(path, opts) {
    const res = await fetch(path, {
      cache: "no-store",
      ...(opts || {}),
      headers: { "content-type": "application/json", "X-RS-Token": token, ...((opts && opts.headers) || {}) },
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }
  function fmt(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }
  async function load() {
    try {
      const s = await api("/api/status");
      const dot = $("dot");
      dot.className = "dot " + (s.online ? "on" : (s.error ? "off" : ""));
      $("state").textContent = s.online ? "在线" : (s.error || "离线");
      $("meta").textContent = [
        s.machine_id ? "machine: " + s.machine_id : "",
        s.expires_at ? "凭证到期: " + fmt(s.expires_at) : "",
        s.configured ? "本机已保存凭证" : "本机未配对",
      ].filter(Boolean).join(" · ");
      $("err").textContent = s.error || "";
      $("serviceMeta").textContent = s.service_installed
        ? (s.service_running ? "服务已安装，正在运行" : "服务已安装，当前停止")
        : "服务未安装（当前为托盘单机模式）";
      $("install").disabled = !!s.service_installed;
      $("uninstall").disabled = !s.service_installed;
      $("autostart").checked = !!s.autostart;
      $("autostart").disabled = !!s.service_running;
    } catch (e) {
      $("state").textContent = "无法读取设置接口";
      $("err").textContent = e.message;
    }
  }
  $("pair").onclick = async () => {
    const link = $("link").value.trim();
    if (!link) { msg($("pairMsg"), "请粘贴连接链接", "bad"); return; }
    $("pair").disabled = true;
    try {
      await api("/api/pair", { method: "POST", body: JSON.stringify({ link }) });
      $("link").value = "";
      msg($("pairMsg"), "已开始连接；配对成功后会自动保存 180 天凭证", "ok");
      setTimeout(load, 800);
    } catch (e) {
      msg($("pairMsg"), e.message, "bad");
    } finally {
      $("pair").disabled = false;
    }
  };
  $("reconnect").onclick = async () => {
    try { await api("/api/reconnect", { method: "POST" }); msg($("pairMsg"), "已请求重连", "ok"); load(); }
    catch (e) { msg($("pairMsg"), e.message, "bad"); }
  };
  $("autostart").onchange = async (event) => {
    try {
      const data = await api("/api/autostart", { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) });
      msg($("autoMsg"), data.autostart ? "已开启开机启动" : "已关闭开机启动", "ok");
      load();
    } catch (e) {
      event.target.checked = !event.target.checked;
      msg($("autoMsg"), e.message, "bad");
    }
  };
  $("install").onclick = async () => {
    if (!confirm("安装为 Windows 服务？需要管理员权限，服务会开机自启并以 LocalSystem 运行。")) return;
    try { await api("/api/service/install", { method: "POST" }); msg($("svcMsg"), "服务已安装并启动", "ok"); load(); }
    catch (e) { msg($("svcMsg"), e.message, "bad"); }
  };
  $("uninstall").onclick = async () => {
    if (!confirm("解除 Windows 服务？托盘单机模式不受影响。")) return;
    try { await api("/api/service/uninstall", { method: "POST" }); msg($("svcMsg"), "服务已解除", "ok"); load(); }
    catch (e) { msg($("svcMsg"), e.message, "bad"); }
  };
  $("quit").onclick = async () => {
    if (!confirm("退出托盘和后台连接？")) return;
    try { await api("/api/quit", { method: "POST" }); window.close(); } catch (e) { alert(e.message); }
  };
  load();
  setInterval(load, 3000);
</script>
</body>
</html>
`
