# 异步任务（juzi_job_*）

长任务不要阻塞 `juzi_exec` 或 `juzi_session_exec`。用异步任务：

```text
juzi_job_start   立即返回 job_id
juzi_job_status  查询状态/耗时/字节数/输出尾部
juzi_job_cancel  取消并杀进程树
juzi_job_list    恢复/查看任务
```

## 推荐用法

```text
< 30 秒              juzi_exec
需要 cd / 变量        juzi_session_*
构建 / 下载 / 部署    juzi_job_*
交互式程序            暂不支持（PTY 未来）
```

## 启动

```json
{
  "machine": "PC-20240827GXKW",
  "shell": "powershell",
  "command": "Start-Sleep 120; Write-Output done",
  "name": "长任务示例"
}
```

返回：

```json
{ "jobId": "j_...", "status": "running", "startedAt": "..." }
```

## 看进度

```json
{
  "job_id": "j_...",
  "wait_ms": 30000,
  "tail_bytes": 32768
}
```

- `wait_ms` 最多 30000，长轮询；任务完成会提前返回
- 不要用 `sleep` 轮询
- 输出只返回尾部，避免把几 GB 日志塞进上下文
- 通用命令没有百分比；进度看 elapsed + bytes + tail

返回字段：

```text
status      running | canceling | canceled | exited | failed
exitCode
durationMs
bytesOut / bytesErr
stdoutTail / stderrTail
truncated
```

## 取消

```json
{ "job_id": "j_..." }
```

会杀整个进程树。已经结束的任务不会被标成 canceled。

## 列出/恢复

```json
{ "machine": "PC-..." }   // 可选
```

DSH 或 WebSocket 重连后，用 `juzi_job_list` 找回 job_id。

## Web 进度

设置页「任务」卡片每 3 秒刷新：

- 名称、机器、状态
- 已运行时间
- stdout/stderr 字节数
- 输出尾部
- 取消按钮

这个轮询走独立 HTTP，不占用模型回合。

## 生命周期

- 任务进程独立于 WebSocket；断线后继续跑
- agent 重启后任务丢失，`job_list` 为空（不会假装还在跑）
- 最多 16 个任务同时保留
- 输出上限：stdout 50 MB，stderr 10 MB
- 完成的任务保留 24 小时后清理
- 取消/退出时杀进程树

## 和其他工具的区别

| 工具 | 状态 | 适合 |
|---|---|---|
| `juzi_exec` | 无 | 短命令 |
| `juzi_session_exec` | 有 | 多步/有状态 |
| `juzi_job_*` | 无 | 长任务、可取消、可看进度 |

job 不保留 `cd`/变量；需要状态就用 session。
