# P0 验收记录

日期：2026-10-26
环境：Debian 13 / Go 1.24.4 / Node 24.22.0

## 构建

```bash
make agent-linux
```

结果：`dist/remote-agent-linux-amd64`，约 9.0 MB。

## 单元测试

```bash
cd agent && go test ./...
```

结果：`ok relay-agent`（沿用上游测试，`run` 包装保留兼容）。

## 端到端（本机 mock DSH）

脚本：`plugin/test/e2e.mjs`

覆盖：

- 插件 host 注册 `remote_hosts` / `remote_exec`
- 创建机器并返回一次性 token
- agent 出站 WebSocket 注册
- `remote_exec` 执行 `uname -a`，`exit_code = 0`
- 发送 `SIGTERM` 后机器在数秒内标记 `offline`

结果：

```text
exec: exitCode 0, stdout "Linux debian13 6.12.113+deb13-amd64 ... GNU/Linux"
after stop: status offline
PASS
```

## 鉴权与重连

额外手工测试：

- 错误 token：agent 被 401 拒绝，机器保持 `offline`
- 正确 token：机器 `online`
- `SIGTERM`：机器 `offline`
- 重启 agent：机器重新 `online`

结果：通过。


## 真实 DSH 验收（2026-10-26 12:47）

环境：DSH Web `0.2.1-rc.2`，插件通过 profile link 加载。

结果：

```text
[remote-shell] loaded: 1 machines, 0 online
[remote-shell] agent listener on 0.0.0.0:47777/api/remote-shell/agent
[remote-shell] agent online: m_p0test0001 P0 Test Linux
```

`remote_hosts`：

```text
- P0 Test Linux `m_p0test0001` online linux/amd64
```

`remote_exec`（machine = P0 Test Linux）：

```text
exit 0
Linux debian13 6.12.113+deb13-amd64 ... GNU/Linux
---
root
/root/Work/Daliy
```

停止 agent 后状态转为 `offline`。

### 结论

DSH 插件、专用端口 47777、token 鉴权、机器台账、命令执行均已在真实 DSH 中跑通。P0 的 Linux 验收完成。

## 尚未验证

- Windows agent 实机运行（只有交叉编译）
- 远程访问所需的端口映射 / Tailscale（P0 不做）
- Windows agent 实机运行（只有交叉编译）
- 命令超时/输出截断/并发上限（逻辑存在，未做破坏性测试）

## 已知限制

- P0 没有 PTY、文件传输、配对码、自动 token 轮换
- agent 端口默认绑定 `0.0.0.0:47777`，仅靠 token 保护；不要直接暴露到公网
- agent 未签名，Windows Defender 可能拦截
- token 一次性展示；丢失需撤销机器重建
- 命令无持久 shell 状态（`cd` 不跨命令）
