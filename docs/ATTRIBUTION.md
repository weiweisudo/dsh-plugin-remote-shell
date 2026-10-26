# 上游与许可

## 上游项目

- 仓库：https://github.com/laatortuejaune/mcp-windows-remote-shell
- 许可：MIT
- 计划复用：`agent/`（Go，单文件、仅监听回环、Bearer token、`/exec`）

## 派生改动（P0）

- 移除 `rendezvous/`（Cloudflare Worker）
- 移除 `mcp-server/`（Node/TypeScript MCP 层）
- 保留 agent 的 token 鉴权、输出限制、进程监管
- 新增主动出站 WSS 模式

## 许可义务

分发派生代码时保留上游 MIT 版权与许可文本；在本仓库根目录补充 `LICENSE` 前不得声称拥有上游代码版权。

## 其他参考

- DSH `dsh-server-deck` 的 `WebSocketServer({ noServer: true })` PTY 模式（本机插件，非上游代码；本仓库改用独立端口）
