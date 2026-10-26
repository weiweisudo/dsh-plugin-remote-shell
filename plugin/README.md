# plugin（P0 待实现）

DSH bundle（host + client），负责机器台账、WS 端点和工具注册。

## Host 侧

- 专用 HTTP 监听（默认 `0.0.0.0:47777`，`REMOTE_SHELL_AGENT_PORT` 可改）
- `/api/remote-shell/agent` WebSocket upgrade
- 机器台账：`~/.dsh/remote-shell/machines.json`（600）
- token 哈希：`~/.dsh/remote-shell/secrets.json`（600）
- 工具：`remote_hosts`、`remote_exec`
- 心跳超时 90s 标记离线

参考 `dsh-server-deck` 的 `WebSocketServer({ noServer: true })` 模式；不挂在 DSH web 端口上，避免被 lanmode 认证拦截。

## Client 侧

- 侧边栏「远程机器」页签
- 机器列表：名称、平台、状态、最后在线
- 状态徽章：在线 / 离线 / 连接中
- P0 只放一个测试命令输入框；终端入口留到 P1

## 配置

```
~/.dsh/remote-shell/machines.json
~/.dsh/remote-shell/secrets.json
~/.dsh/logs/remote-shell.jsonl
```

## 安全

- 不存明文 token
- WS 注册必须校验 token
- 不提供提权
