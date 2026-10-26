# 验收记录

日期：2026-10-26
环境：Debian 13 / Go 1.24.4 / Node 24.22.0

## P0：出站 WebSocket + 远程执行

### 真实 DSH

```text
[remote-shell] loaded: 1 machines, 0 online
[remote-shell] agent listener on 0.0.0.0:47777/api/remote-shell/agent
[remote-shell] agent online: m_p0test0001 P0 Test Linux
```

`remote_hosts`：

```text
- P0 Test Linux `m_p0test0001` online linux/amd64
```

`remote_exec`：

```text
exit 0
Linux debian13 6.12.113+deb13-amd64 ... GNU/Linux
---
root
/root/Work/Daliy
```

停止 agent 后状态转为 `offline`。

## P0.5：配对链接 + 自动注册 + 设备凭证

### 本机端到端

脚本：`plugin/test/e2e.mjs`

```text
[remote-shell] agent listener on 0.0.0.0:48708/api/remote-shell/agent
pairing link ok
[remote-shell] agent online: m_04e32a37a826 pair-e2e
credentials: saved machine_id=m_04e32a37a826 expires=2027-04-24T06:42:53.947Z
paired + exec ok
device credential reconnect ok
PASS: pair -> auto register -> exec -> credential reconnect
```

覆盖：

- `POST /api/remote-shell/pairings` 生成一次性链接
- 链接 secret 在 `#` fragment，不进入 HTTP 请求
- agent `--pair` 首次连接自动创建机器
- 服务端下发 180 天 `device_token`
- agent 写入 `credentials.json`
- 删除配对链接后，agent 仅凭设备凭证重连成功
- `remote_exec` 返回 `exit 0`

### 构建

```bash
cd agent
GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ../dist/remote-agent-linux-amd64 .
GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o ../dist/remote-agent-windows-amd64.exe .
```

结果：

- Linux：约 6.1 MB
- Windows：约 6.8 MB（含托盘/服务）
- `go test ./...` 通过
- `GOOS=windows go vet ./...` 通过

## 尚未验证

- Windows 实机：托盘、本地设置页、服务安装/解除、系统明暗
- DSH 插件新 UI 的真实浏览器视觉验收
- 远程访问所需的端口映射 / Tailscale（P0 不做）
- 命令超时/输出截断/并发上限的破坏性测试

## 已知限制

- Windows 凭证当前是 0600 文件，尚未接 DPAPI
- 服务安装/解除需要管理员；UI 非管理员会返回错误
- 插件 agent 端口默认 `0.0.0.0:47777`，仅 token 保护，不要直接映射公网
- agent 未签名，Windows Defender 可能拦截
- 配对链接包含 secret，注意 shell 历史；链接一次性、5 分钟
- 命令无持久 shell 状态（`cd` 不跨命令）
