# 远程类插件怎么选

本机有多套“远程”能力，**它们的数据源和权限模型完全不同**。先看这张表，不要按名字猜。

| 插件 | 工具前缀 | 目标 | 连接方式 | 典型机器 |
|---|---|---|---|---|
| **桔子会话**（本插件） | `juzi_*` | 装有 Juzi agent 的机器 | agent 主动出站 WebSocket | `PC-20240827GXKW` |
| `dsh-server-deck` | `server_deck_*` | SSH 主机 | DSH 主机发起的 SSH | `synology-dsm` |
| `dsh-remote` | `rw_*` | SSH 远程工作区 | SSH / 端口转发 | 远程 Linux 工作区 |
| `browser-skill` | `bsk_*` | 浏览器 | 扩展 / daemon | 本机或远程浏览器 |
| `dsh-lanmode` | 无工具 | DSH Web 访问 | 反向代理 / LAN | 不是机器执行 |

## 决策树

```text
要操作一台机器？
├─ 它在 juzi_hosts 里？
│  ├─ 是 → juzi_exec / juzi_session_*
│  └─ 否 ↓
├─ 它在 server_deck_hosts 里？
│  ├─ 是 → server_deck_exec
│  └─ 否 ↓
├─ 它是 dsh-remote 的 SSH 工作区？
│  ├─ 是 → rw_* 工具
│  └─ 否 ↓
└─ 要操作浏览器？
   └─ 是 → bsk_*
```

## 桔子会话

```text
juzi_hosts
juzi_exec
juzi_session_open
juzi_session_exec
juzi_session_close
```

- **只**管理通过一次性配对链接注册的 outbound agent
- 不依赖 sshd / WinRM
- Windows/Linux agent 主动连 DSH
- 机器 ID 形如 `m_...`
- 状态在 `~/.dsh/remote-shell/`

## 常见错误

| 错误 | 原因 | 正确做法 |
|---|---|---|
| `台账里没有主机 PC-...` | 用了 `server_deck_exec` 查 Juzi 机器 | 用 `juzi_exec` |
| `machine not found` | 用了 `juzi_exec` 查 SSH 主机 | 用 `server_deck_exec` 或 `rw_*` |
| `server_deck_hosts` 输出 JSON 错误 | Server Deck 自身序列化问题 | 与本插件无关 |
| `juzi_exec` 找不到机器 | agent 没在线/没配对 | 先看 `juzi_hosts` |

## 命名约定

- 人类名称：**桔子会话**
- 工具前缀：`juzi_`
- 技术包名：`dsh-plugin-juzi-remote-shell`；GitHub 仓库：`juzi-remote-shell`
- 旧 `remote_*` 工具名已移除，避免和 `dsh-remote` 混淆
