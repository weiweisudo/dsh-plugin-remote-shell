# plugin

DSH bundle（host + client）：配对、机器台账、WS 端点和工具注册。

## Host

- 专用 HTTP 监听（默认 `0.0.0.0:47777`，`REMOTE_SHELL_AGENT_PORT` 可改）
- `/api/remote-shell/agent` WebSocket
- `GET /api/remote-shell/config` 读取配对地址列表与当前项
- `POST /api/remote-shell/presets` / `DELETE /api/remote-shell/presets/:id` 增删配对地址
- `POST /api/remote-shell/switch` 切换当前配对地址
- `POST /api/remote-shell/pairings` 生成一次性链接（5 分钟），优先使用配置的前缀
- `GET /api/remote-shell/pairings` 等待中的配对
- `GET /api/remote-shell/machines` 机器列表
- `DELETE /api/remote-shell/machines/:id` 撤销
- 工具：`remote_hosts`、`remote_exec`（一次性）
- 工具：`remote_session_open` / `remote_session_exec` / `remote_session_close`（持久 shell）
- 与 `dsh-server-deck` 的 `server_deck_*` **不是同一套台账**：本插件只管理主动出站的 agent 机器
- 配对 secret / 设备 token 只存 SHA-256；设备凭证 180 天

状态文件：

```
~/.dsh/remote-shell/machines.json
~/.dsh/remote-shell/secrets.json
~/.dsh/remote-shell/pairings.json
```

不挂在 DSH web 端口上，避免被 lanmode 认证拦截。

## Client

- 设置页「远程机器」
- 生成一次性连接链接 + 复制命令 + 5 分钟倒计时
- agent 连上后自动出现在机器列表，无需先创建
- 在线 / 离线、系统、凭证到期、最后在线、撤销
- 跟随 DSH Web 明暗：监听 `body[data-ds-dark-theme]`

## 本地开发

```bash
cd plugin
npm install
node --check lib/index.mjs
node --check lib/client.js
node test/e2e.mjs
```

`@deepseek-ai/dsh-tools` 由 DSH profile 提供；本地测试时链接到 profile 的 `node_modules`。
