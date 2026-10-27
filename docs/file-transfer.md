# 桔子会话：文件传输与断点续传方案

- 状态：阶段 1 已实现（单文件上传/下载、SHA、`.part`、2 并发 + 4 排队、DSH 传输卡片）
- 版本：v0.2
- 日期：2026-10-27

## 0. v0.2 实施修订

已定：

- 不做路径白名单
- Windows 服务默认上传目录：`%ProgramData%\dsh-remote-shell\Downloads`
- Linux 服务默认上传目录：`~/.local/share/juzi/downloads`
- 桌面/headless 默认：用户 `Downloads`
- agent 是 2 并发 + 4 排队的唯一权威
- 下载端 DSH 本地同样使用 `<local>.part` + `<local>.part.meta`
- 下载握手：`file_request` → `file_offer` → `file_ready` → chunks
- 传输状态增加 `preparing`
- 本阶段先完成工具与 DSH UI；断线自动续传、插件重启恢复、受控机本地传输卡片在阶段 2
- 适用：`dsh-plugin-juzi-remote-shell` / `juzi-remote-shell` agent
- 原则：单端口、单 exe、可控但不做路径白名单

---

## 1. 结论

文件传输复用现有 outbound WebSocket，不新增监听端口，不新增第二个 exe。

```text
DSH Web
  └─ 插件 Hub
       └─ WebSocket :777 /api/remote-shell/agent
            └─ Agent transferManager
                 ├─ 文件 .part
                 ├─ 本地 UI :49777–49796
                 └─ 本地传输状态 API
```

定稿：

| 项 | 决定 |
|---|---|
| 路径白名单 | 不做 |
| 默认上传目录 | Windows `%USERPROFILE%\Downloads`，Linux `~/Downloads` |
| 默认下载目录 | DSH 当前工作区 |
| 相对路径 | 解析到默认目录 |
| 绝对路径 | 直接使用 |
| 父目录 | 自动创建 |
| 覆盖 | 默认 `false`，显式 `overwrite=true` 才覆盖 |
| 大小 | 不设硬上限；>2 GB UI 提示；开始前检查磁盘余量 |
| 并发 | 2 个 running + 最多 4 个 queued |
| 分块 | 64 KB |
| 发送窗口 | 8 MB |
| 空闲超时 | 60 秒 |
| 单次最长 | 24 小时 |
| 续传 | 默认开启，断线/重启后自动恢复 |
| 校验 | SHA-256 |
| `.part` 保留 | 7 天 |
| 重试 | 自动最多 5 次，指数退避 |
| 两端 UI | DSH 插件 UI + 受控机本地 UI 都显示 |

---

## 2. 系统兼容性

目标平台：

- Windows 10 / 11 amd64：托盘、服务、本地 UI
- Linux amd64：headless，通过 DSH 工具使用
- 不承诺 macOS / Windows ARM / Linux ARM；可以交叉编译，但未验收
- 文件传输核心不依赖桌面 UI；Windows 有本地 UI，Linux 暂无本地托盘 UI

### 硬性约束

文件传输核心只使用 Go 标准库和已有依赖：

```text
os, io, filepath, crypto/sha256, encoding/json, encoding/binary,
sync, time, context
```

现有依赖仅：

```text
github.com/gorilla/websocket   （已有）
golang.org/x/sys/windows       （已有 Windows 适配）
```

不新增第三方文件传输库。

明确禁止依赖：

- PowerShell / cmd / certutil
- curl / wget / tar / rsync / 7z
- .NET / WMI / COM 组件
- 外部 DLL / 驱动 / 服务
- cgo
- 平台专用的文件管理器 API

文件读写、分块、哈希、rename 都在 agent 进程内完成。

构建约束：

```text
Go 1.24+
CGO_ENABLED=0
Windows: -H windowsgui
Linux: 静态/无 cgo
插件: Node.js 纯 JS，无 native addon
```

平台专用代码只允许放在 build-tag 文件里：

```text
replace_windows.go
replace_unix.go
diskfree_windows.go
diskfree_unix.go
```

协议和传输核心不得 import `windows` 包。

### 特性协商

agent hello 增加：

```json
{"features": ["jobs", "sessions", "shell", "files"]}
```

- 旧 agent 没有 `files`：插件不注册/不暴露文件工具
- 新插件遇到旧 agent：返回“agent 版本过低”，不卡住
- 文件工具和 job 工具一样做 feature 检测
- 协议版本不匹配时只禁用文件功能，不影响 exec/session

### 跨平台文件操作

- 路径统一用 `filepath`，不手拼 `/` 或 `\`
- 协议字段不包含平台专用参数
- JSON 统一 UTF-8；文件内容按原始字节传输，不做编码转换
- Windows 路径和 Linux 路径都按本地原生格式处理
- 不依赖 Unix 权限位：`chmod` 仅 best-effort，Windows 上忽略
- 不依赖文件时间戳/ACL/扩展属性

原子替换：

```text
Unix:    os.Rename
Windows: MoveFileEx(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
```

封装为 `replaceFile`：

- build tag 隔离 Windows / Unix 实现
- 不使用第三方库
- Windows 调用失败时 fallback 到 `remove + rename`，并记录“非原子替换”警告
- 普通新建文件优先 `os.Rename`

磁盘余量：

- Unix 用 `statfs`
- Windows 用 `GetDiskFreeSpaceEx`
- 封装为 `diskFree(path)`
- 无法获取时不做硬拦截，靠写入错误返回 `no_space`

### 平台边界

| 功能 | Windows | Linux |
|---|---|---|
| 文件上传/下载 | 支持 | 支持 |
| 断点续传 | 支持 | 支持 |
| DSH 端 UI | 支持 | 支持 |
| 受控机本地 UI | 支持 | 暂不支持（headless） |
| 托盘/服务 | 支持 | 服务用 systemd/手动 |
| 大文件 | 支持 | 支持 |

Linux 受控机不额外做托盘 UI；传输状态在 DSH UI 查看。

### 兼容性验收

- Windows 10 22H2 / Windows 11
- Debian 13 / Ubuntu 24.04（至少一个）
- 不使用 WSL 作为兼容性替代
- 相同文件在 Windows ↔ Linux 双向传输 SHA-256 一致
- 路径含中文、空格、括号、长路径时可用（长路径受系统限制，不额外绕过）
- 不要求目标机安装 PowerShell 7、curl、.NET

## 3. 目标与非目标

### 目标

- 单文件上传：DSH 本机 → 受控机
- 单文件下载：受控机 → DSH 本机
- 绝对/相对路径都支持
- 默认不覆盖
- 断线后续传
- agent 重启后续传
- DSH 插件重启后续传
- 2 个并发传输
- DSH 和受控机本地 UI 都能看状态、取消
- 完成后原子落盘并校验 SHA-256

### 非目标

- 目录递归同步
- 文件系统浏览器的完整替代
- 断点续传之外的差分同步
- 浏览器拖拽上传（后续可加）
- SFTP/FTP/HTTP 文件服务
- 上传后自动执行
- 文件版本管理

---

## 4. 默认路径与命名

### 受控机默认上传目录

```text
Windows:
  %USERPROFILE%\Downloads

Linux:
  ~/Downloads
```

### DSH 默认下载目录

```text
DSH 当前会话工作区
```

- `local_path` 省略：工作区 + 远端文件名
- 相对路径：解析到工作区
- 绝对路径：直接使用
- 不额外创建 `downloads` 子目录（用户明确选择工作区）

### 路径规则

- `remote_path` 为空：使用默认上传目录 + 源文件名
- 相对路径：拼到默认目录
- 绝对路径：原样使用
- 自动 `MkdirAll(parent)`
- 只拒绝空路径和包含 NUL 的路径
- 不拒绝 `..`、符号链接；已有 shell 权限，路径白名单没有实际安全收益
- 覆盖策略独立于路径策略

### 传输临时文件

目标文件同目录：

```text
<target>.part
<target>.part.meta
```

例：

```text
C:\Users\me\Downloads\a.zip.part
C:\Users\me\Downloads\a.zip.part.meta
```

---

## 5. 数据模型

### Transfer

```json
{
  "id": "t_9f2c...",
  "machineId": "m_...",
  "direction": "upload",
  "localPath": "/root/Work/Daliy/a.zip",
  "remotePath": "C:\\Users\\me\\Downloads\\a.zip",
  "size": 123456789,
  "sha256": "...",
  "status": "running",
  "bytesDone": 83886080,
  "speed": 12582912,
  "attempt": 0,
  "error": "",
  "createdAt": "2026-10-27T11:00:00Z",
  "updatedAt": "2026-10-27T11:00:08Z"
}
```

状态机：

```text
queued
  └─ running
       ├─ verifying
       │    ├─ completed
       │    └─ failed
       ├─ paused ──> running（续传）
       ├─ canceling ──> canceled
       └─ failed
```

### 持久化

Agent：

```text
<target>.part
<target>.part.meta
```

Meta：

```json
{
  "transfer_id": "t_9f2c...",
  "direction": "upload",
  "path": "C:\\Users\\me\\Downloads\\a.zip",
  "size": 123456789,
  "sha256": "...",
  "updated_at": "2026-10-27T11:00:08Z"
}
```

DSH 插件：

```text
~/.dsh/remote-shell/transfers.json
```

保存未完成和最近完成的 transfer，用于插件重启恢复。

历史保留规则：

- 最多保留最近 **10 条**已结束记录（completed/failed/canceled）
- 未完成/paused 记录始终保留
- 超过 10 条时删除最旧的已结束记录
- 不保留文件内容，只保留元数据

---

## 6. 工具

```text
juzi_file_put(machine, local_path, remote_path?, overwrite=false, resume=true)
juzi_file_get(machine, remote_path, local_path?, overwrite=false, resume=true)
juzi_file_stat(machine, path)
juzi_file_list(machine, path?)
juzi_transfer_status(transfer_id, wait_ms?)
juzi_transfer_cancel(transfer_id)
juzi_transfer_list(machine?)
```

### juzi_file_put

输入：

- `local_path`：DSH 本机源文件
- `remote_path` 可选：受控机目标
- `overwrite` 默认 `false`
- `resume` 默认 `true`

立即返回：

```json
{
  "transferId": "t_...",
  "direction": "upload",
  "remotePath": "C:\\Users\\me\\Downloads\\a.zip",
  "size": 123456789,
  "status": "queued"
}
```

### juzi_file_get

输入：

- `remote_path`：受控机源文件
- `local_path` 可选：DSH 本地目标；省略时为当前工作区 + 远端文件名
- `overwrite` 默认 `false`
- `resume` 默认 `true`

### juzi_transfer_status

```json
{
  "transferId": "t_...",
  "status": "running",
  "bytesDone": 83886080,
  "size": 123456789,
  "speed": 12582912,
  "etaSeconds": 3,
  "attempt": 1,
  "error": ""
}
```

`wait_ms` 最多 30000，长轮询；任务完成提前返回。

### 队列语义

- 2 个 running
- 第 3 个进入 queued
- 队列最多 4 个
- 超过 6 个直接拒绝
- 取消 queued 不创建 `.part`

---

## 7. 协议

控制消息为 JSON text frame；文件数据为 binary frame。

### 消息总表

| 消息 | 方向 | 说明 |
|---|---|---|
| `file_begin` | sender → receiver | 声明文件、大小、SHA、路径 |
| `file_ready` | receiver → sender | 返回续传 offset |
| `file_chunk` | sender → receiver | 二进制数据 |
| `file_ack` | receiver → sender | 已落盘 offset |
| `file_end` | sender → receiver | 发送结束，声明 SHA |
| `file_result` | receiver → sender | 最终成功/失败 |
| `file_abort` | 双向 | 中止 |
| `file_pause` | 双向 | 暂停 |
| `file_status` | agent → plugin | 状态/进度事件 |

### file_begin

```json
{
  "type": "file_begin",
  "id": "req_...",
  "transfer_id": "t_...",
  "direction": "upload",
  "path": "C:\\Users\\me\\Downloads\\a.zip",
  "size": 123456789,
  "sha256": "...",
  "overwrite": false,
  "resume": true
}
```

### file_ready

```json
{
  "type": "file_ready",
  "id": "req_...",
  "transfer_id": "t_...",
  "offset": 67108864,
  "path": "C:\\Users\\me\\Downloads\\a.zip"
}
```

- `.part` 与 meta 匹配：返回已有长度
- 不匹配：从 0 开始
- 目标存在且 `overwrite=false`：返回 `file_error`

### file_chunk 二进制头

```text
offset  size  field
0       3     magic "JZ1"
3       1     version/type（1 = data）
4       16    transfer id（hex 解码后的 16 字节）
20      8     file offset，小端
28      4     payload size，小端
32      N     payload
```

单块 payload 64 KB；整帧不超过 128 KB。

### file_ack

```json
{
  "type": "file_ack",
  "transfer_id": "t_...",
  "offset": 68157440
}
```

### 流控

- 发送窗口：8 MB
- 未确认字节超过窗口：暂停发送
- 接收方每 1 MB 或 1 秒回 ACK
- ACK 必须单调递增
- 重复/过期 ACK 忽略

### file_end

```json
{
  "type": "file_end",
  "transfer_id": "t_...",
  "sha256": "..."
}
```

接收方：

1. 校验总大小
2. 校验 SHA-256
3. fsync
4. 原子 rename
5. 删除 `.part.meta`
6. 返回 `file_result`

### file_result

```json
{
  "type": "file_result",
  "transfer_id": "t_...",
  "ok": true,
  "path": "C:\\Users\\me\\Downloads\\a.zip",
  "size": 123456789
}
```

### 错误码

```text
bad_request
not_found
exists
no_space
sha256_mismatch
size_mismatch
offset_mismatch
permission_denied
canceled
timeout
too_many_transfers
io_error
```

---

## 8. 续传设计

### 核心原则

**接收方是 offset 的唯一权威。**

发送方不能自己假设从哪继续，必须问接收方。

### 接收方准备

1. 目标存在且不覆盖：失败
2. `.part` 不存在：创建，offset = 0
3. `.part` 存在：
   - 读 `.part.meta`
   - 比较 `transfer_id`、路径、大小、SHA
   - 全部匹配且未过期：offset = `.part` 长度
   - 否则删除旧 `.part`，offset = 0
4. 返回 `file_ready(offset)`

### 发送方继续

- 上传：DSH 本地文件 `Seek(offset)`
- 下载：agent 远程文件 `Seek(offset)`
- 从 offset 开始分块

### 断线

- WebSocket 断开：transfer → `paused`
- 不删除 `.part`
- 插件记录 `paused`
- 重连后自动 `file_begin(resume=true)`
- 最多 5 次，退避 1s/2s/4s/8s/16s

### agent 重启

- 内存 transfer 丢失
- `.part` / `.part.meta` 仍在磁盘
- 插件重连后重新 `file_begin`
- agent 重新读 `.part`，决定 offset
- 无 `.part` 则从 0 开始

### 插件重启

- `transfers.json` 恢复未完成 transfer
- 机器在线则自动续传
- 机器离线则保持 `paused`
- 不把 `paused` 显示成完成

### 源文件变化

- 开始前算整个文件 SHA-256
- 续传时重新校验源文件大小和 SHA
- 不一致：失败，要求重新发起
- 不允许“续传一个已经变化的文件”

### 取消

默认且唯一行为：

```text
cancel → 删除 .part 和 .part.meta
```

不提供保留现场选项，避免残留和额外复杂度。

### 最终落盘

- 先写 `.part`
- 完成后 fsync
- 校验 SHA
- 原子 rename
- 目标存在且允许覆盖时用跨平台 `replaceFile`
- Unix `os.Rename`；Windows `MoveFileEx(REPLACE_EXISTING | WRITE_THROUGH)`
- 跨设备时 `copy + rename`；失败不可回滚时明确报错

---

## 9. 两端 UI

### DSH 插件 UI

位置：设置页 / 侧栏「传输」卡片。

字段：

- 文件名
- 机器
- 方向
- 进度
- 速度
- 状态
- 重试次数
- 错误

操作：

- 取消
- 重试
- 打开文件所在目录（仅下载）

### 受控机 agent UI

本地设置页「传输」卡片：

- 文件名
- 方向（接收/发送）
- 目标路径
- 进度
- 状态
- 取消

只显示本机传输，不显示其他机器。

历史：

- 最近 10 条已结束记录
- 超过 10 条丢弃最旧
- 不保留文件内容

### 刷新策略

- Agent → 插件：每 1 MB 或 1 秒发 `file_status`；状态变化立即发
- DSH UI：每 2 秒轮询 `/api/remote-shell/transfers`
- Agent UI：每 1 秒轮询 `/api/transfers`
- 不把每个 64 KB 块推给 UI
- 两端 UI 都只保留最近 10 条已结束记录
- 未完成/paused 的记录始终显示

### 新增接口

Agent 本地：

```text
GET  /api/transfers
POST /api/transfers/{id}/cancel
POST /api/transfers/{id}/retry
```

DSH 插件：

```text
GET  /api/remote-shell/transfers
POST /api/remote-shell/transfers/{id}/cancel
```

---

## 10. 安全与审计

不做路径白名单，但仍保留：

- 空路径/NUL 拒绝
- 默认不覆盖
- 磁盘余量检查（平台 helper，取不到时跳过）
- 传输审计
- 取消
- 2 并发上限
- 单次 24 小时上限
- 上传后不自动执行
- token 鉴权
- 本地 UI 仍只监听 loopback

审计日志字段：

```text
时间、机器、方向、路径、大小、SHA256、开始 offset、
结果、错误、重试次数
```

不记录文件内容。

仍然要明确：文件传输会显著扩大 agent 的能力边界，公开文档应说明这是远程管理工具，不是隐蔽监控工具。

---

## 11. 失败处理

| 情况 | 行为 |
|---|---|
| 目标存在，overwrite=false | 失败，原文件不动 |
| 目标存在，overwrite=true | `.part` 完成后原子替换 |
| 磁盘不足 | 开始前失败 |
| 传输中磁盘满 | `.part` 保留，pause/failed |
| 源文件变化 | SHA 不匹配，失败 |
| 断线 | paused，保留 `.part` |
| offset 不匹配 | 从 0 重传 |
| agent 重启 | 从 `.part.meta` 续传 |
| 插件重启 | 从 `transfers.json` 续传 |
| 取消 | 删除 `.part` |
| 超过 24h | failed，`.part` 保留 7 天 |
| 校验失败 | 删除 `.part`，失败 |
| 并发超限 | queued，超过队列上限拒绝 |

---

## 12. 实施计划

### 阶段 1：协议与核心传输

- 二进制帧读写
- `transferManager`
- `file_begin/file_ready/file_chunk/file_ack/file_end`
- `.part` + `.meta`
- SHA-256 校验
- 原子落盘
- `juzi_file_put/get`
- 单元测试 + loopback 集成测试

### 阶段 2：续传

- 接收方 offset 协商
- 发送方 seek
- 断线 pause/resume
- agent 重启恢复
- 插件重启恢复
- 取消和 `.part` 清理
- 自动重试

### 阶段 3：并发与 UI

- 2 running + 4 queued
- agent 本地 UI 传输卡片
- DSH 插件传输卡片
- 进度/速度/ETA
- 取消/重试
- 大文件提示

### 阶段 4：验收与加固

- 1 MB / 100 MB / 1 GB
- 断网、重启、校验失败、磁盘满
- 反向代理 777 下的长连接
- 审计日志
- 代码签名前检查

预计：

```text
核心 + 续传：5–7 天
并发 + 两端 UI：2–3 天
异常 + 大文件验收：2–3 天
合计：约 1.5–2 周
```

---

## 13. 验收标准

必须全部通过：

- [ ] 单端口 777，无新增监听端口
- [ ] 单 exe，无额外二进制
- [ ] 上传/下载各 1 MB、100 MB、1 GB 成功
- [ ] SHA-256 全部一致
- [ ] 默认不覆盖；`overwrite=true` 才覆盖
- [ ] 断开 WebSocket 后续传 offset 正确
- [ ] agent 重启后续传成功
- [ ] 插件重启后续传成功
- [ ] 2 个并发同时 running
- [ ] 第 3 个进入 queued
- [ ] DSH UI 显示进度、速度、状态
- [ ] 受控机 UI 显示本机传输
- [ ] 两端都能取消
- [ ] 取消后 `.part` 默认删除
- [ ] 磁盘不足、SHA 不匹配有明确错误
- [ ] 审计日志包含路径、大小、SHA、结果
- [ ] Windows 10/11 与 Linux 双向 SHA-256 一致
- [ ] 不依赖 PowerShell/curl/.NET/外部 DLL
- [ ] 中文、空格、括号路径可用

---

## 14. 已定决策

1. 下载默认目录：DSH 当前工作区
2. 取消传输：删除 `.part`，不保留现场
3. 浏览器拖拽上传：不做
4. 传输历史：只保留最近 10 条已结束记录
5. 限速/复杂功能：不做

明确不做：

- 目录递归同步
- 浏览器文件选择器
- 按机器限速
- 传输历史长期归档
- 上传后自动执行
- 独立文件服务端口

## 15. 实现约定

- DSH 当前工作区优先从工具上下文获取；没有上下文时用进程 cwd
- 工作区同名文件默认不覆盖，直接返回 `exists`；不自动加 `(1)`
- 超过 2 GB 只提示，不阻止
- 插件重启后从 `transfers.json` 恢复最近 10 条历史显示
- 传输历史不包含文件内容，只保留元数据

## 16. 一句话

文件数据复用现有 WebSocket，只增加二进制帧、`.part` 状态和两端状态视图；不做路径白名单，默认不覆盖，续传和 2 并发一次做完，仍然保持单端口、单 exe。
