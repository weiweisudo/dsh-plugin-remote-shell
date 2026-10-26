# dsh-plugin-remote-shell

DSH 的远程机器管理插件（P0 阶段）。

目标：被控端（Windows / Linux）**主动出站**连接 DSH，由 DSH 统一管理已授权机器并下发非交互命令；后续增加交互终端（PTY）和文件传输。

## 为什么

- 目标机经常没有 sshd / WinRM，或不允许开系统服务
- 家宽 CGNAT，无法依赖入站端口
- 希望像 browser-skill 一样：被控端主动连出，DSH 侧统一管理

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 出站连接 + 机器台账 + `remote_exec` | Linux 验收通过；Windows 待冒烟 |
| P1 | 配对码、token 轮换、审计 | 未开始 |
| P2 | 交互终端（ConPTY / pty） | 未开始 |
| P3 | 文件传输（白名单目录） | 未开始 |

## 目标架构

```
Windows / Linux 目标机
  └─ remote-agent（Go 单文件，普通用户运行）
        │ 出站 WebSocket（心跳 + 重连）
        ▼
DSH 插件「远程机器」（专用端口 47777，可配置）
  ├─ /api/remote-shell/agent      注册、心跳、命令、后续 PTY/文件复用
  ├─ 机器台账（已授权、状态、token、允许目录）
  ├─ 工具：remote_hosts / remote_exec
  └─ 设置页：机器列表、创建/撤销、token 一次性展示
```

## P0 范围

- agent 从 [mcp-windows-remote-shell](https://github.com/laatortuejaune/mcp-windows-remote-shell) 的 Go agent 派生（MIT）
- 去掉 Cloudflare Worker / MCP server 依赖
- 增加主动出站 WebSocket 模式（插件专用端口 47777）
- DSH 插件：WS 端点、机器台账、`remote_hosts`、`remote_exec`
- Linux 端到端验收；Windows 交叉编译 + 局域网冒烟

详细计划见 [docs/P0.md](docs/P0.md)。

## 目录

```
agent/    Go agent（P0 已实现）
plugin/   DSH 插件 bundle（P0 已实现）
docs/     计划、协议、许可说明
```

## 安全

- agent 仅以运行它的用户权限执行命令，**不提供提权**
- token 只在创建时显示一次；插件侧只存 SHA-256 哈希，不回显
- agent 端口默认 `0.0.0.0:47777`，仅 token 保护；不要直接映射到公网
- 文件传输阶段必须使用目录白名单（P3）
- 只处理已授权机器

## 许可

上游 agent 为 MIT，派生代码必须保留版权声明。详见 [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md)。
本仓库自身许可待定。
