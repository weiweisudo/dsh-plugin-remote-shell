# Windows Agent 设计

## 形态

单文件 `remote-agent.exe`，三种入口：

```
remote-agent.exe                 托盘 + 本地设置页 + worker（单机模式）
remote-agent.exe service install 安装 Windows 服务（需管理员）
remote-agent.exe service uninstall 解除服务（需管理员）
remote-agent.exe --service       SCM 内部入口，无 UI
```

## 单机模式

- 启动后托盘出现图标
- 点「打开设置」打开 `http://127.0.0.1:<port>/#token=...`
- 关闭浏览器/设置页不会退出；托盘和 worker 继续
- 托盘菜单：状态、打开设置、重新连接、安装服务、解除服务、退出

## 本地设置页

- 可修改“设备名称”（保存到 `%LOCALAPPDATA%\dsh-remote-shell\settings.json`，保存后自动重连）


- 只绑 `127.0.0.1`
- 端口从 `49777` 到 `49796` 顺序尝试；全部占用时绑定临时端口
- token 放 URL fragment，不发给服务器；页面 JS 读取后放 `X-RS-Token`
- 页面跟随 Windows **系统明暗**（`prefers-color-scheme`）
- 功能：
  - 粘贴一次性配对链接
  - 查看在线状态 / machine id / 凭证到期
  - 重新连接
  - 安装/解除服务
  - 退出托盘

## 开机启动

托盘和本地设置页都有「开机启动」开关：

- 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- 值名 `DSHRemoteShell`，内容为当前 exe 路径
- 用户登录后启动托盘，不需要管理员
- 比服务轻，保留用户桌面环境
- 如果安装了服务，建议关闭开机启动，避免服务 + 托盘重复连接

## Windows 服务

```powershell
remote-agent.exe service install
remote-agent.exe service uninstall
remote-agent.exe service start
remote-agent.exe service stop
```

- 服务名：`dsh-remote-shell`
- 显示名：`DSH Remote Shell Agent`
- 账户：`LocalSystem`
- 启动：自动
- 失败恢复：5s / 10s / 30s 重启
- 配置文件：`%ProgramData%\dsh-remote-shell\credentials.json`
- 日志：`%ProgramData%\dsh-remote-shell\agent.log`
- 安装前先完成一次配对；安装命令会把当前用户的凭证复制到 ProgramData

服务模式不能显示 GUI（Session 0），因此 UI 与 worker 必须分开：托盘模式用于配置，服务模式用于无人值守。

## 凭证

- 首次配对：一次性 secret（5 分钟）
- 首次连接后：180 天 device token
- 到期前 30 天：服务端轮换 token，agent 收到后覆盖保存
- 撤销：插件删除 token 并断开连接

当前 P0.5 凭证在 Windows 上为 0600 文件；后续用 DPAPI 加密。

## 稳定性取舍

| 方式 | 稳定性 | 适用 |
|---|---|---|
| Windows 服务 | 最高，开机即起，UI 崩溃不影响 | 无人值守 |
| 托盘单机 | 高，登录后自启，关闭设置页不影响 | 个人 PC |
| 前台运行 | 低 | 调试 |

## PowerShell 引号与中文

一次性 `juzi_exec(shell="powershell")` 使用临时 `.ps1`（UTF-8 BOM）+ `-File`，不再经过 Windows 命令行引号解析，因此 `$x = "abc"` 不会被吞引号。没有用 `-EncodedCommand`，避免被目标机的 ASR/AppLocker 规则拦截。

PowerShell 命令会自动加：

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8
```

所以中文和 `Microsoft Windows 10 专业版` 能正常按 UTF-8 返回。`cmd` 的 `chcp 65001` 仍可能因程序自身代码页乱码。cmd 输出是 OEM 代码页字节流，不是 UTF-8；agent 现在会在输出不是合法 UTF-8 时按 OEM 代码页兜底解码。但这不改变文件字节：`echo 中文 > f.txt` 写入的仍然是 GBK，中文任务仍建议用 PowerShell。

## 隐藏窗口

agent 启动的 `cmd` / `powershell` 子进程使用 `CREATE_NO_WINDOW` / `HideWindow`，不会弹控制台窗口。这个参数不建议开放为“可见”，因为远程 agent 没有交互桌面，弹出窗口只会干扰用户。

## 连续执行

- `remote_exec`：一次性进程，不保留 cwd/env/变量
- `remote_session_open/exec/close`：持久 shell，`cd` / 变量 / cwd 跨命令保留，每条命令仍返回结构化 exit code / stdout / stderr / cwd
- Windows 持久会话默认 PowerShell；`cmd` 持久会话暂不支持（用一次性 `remote_exec`）
- 真正的交互终端（xterm / ConPTY）还没做；agent 不需要读终端屏幕

持久会话不是 PTY：stdout/stderr 分开，输出适合 agent。

### 会话超时

当前 `juzi_session_exec` 超时会**销毁整个会话**，这是为了不留下无法回收的 shell。大型任务不要把 `timeout_ms` 设得刚好卡边界：

- 短任务：默认 60s
- 长任务：明确设置更大的 `timeout_ms`（最大 3600000）
- 真正超过 DSH 工具调用上限的任务：应该用异步 job，而不是一直加 timeout

异步 job（`juzi_job_start/status/cancel`）是下一步，不把长任务塞进同步 session。

## 管理员权限

当前实测：

```text
PC-...\Administrator
IsInRole(Administrator) = False
Mandatory Label\Medium
```

用户名是 Administrator，但 UAC 过滤后是 Medium，不是 elevated。

可行方式：

1. **Windows 服务**：`service install`，LocalSystem，无 UAC，适合无人值守；不能操作桌面 GUI
2. **以管理员身份启动**：右键“以管理员身份运行”或 `Start-Process -Verb RunAs`，启动时一次 UAC
3. **计划任务**：创建时勾选“使用最高权限运行”，登录后自动以 elevated 启动；需管理员创建一次
4. **每条命令 UAC**：会弹桌面确认，输出捕获困难，服务模式通常弹不出来，不推荐

Windows 不允许静默提权，没有“自动申请管理员且无人确认”的可靠方案。

## 已知限制

- 交叉编译已通过，尚未在 Windows 实机验收托盘/服务
- `service install` 需要管理员；UI 里非管理员会返回错误
- 服务安装后，单机托盘会停止自己的 worker，避免重复连接
- 解除服务需要管理员；服务停止是异步的，安装器会等待
