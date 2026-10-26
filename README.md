# dsh-plugin-remote-shell

DSH 的远程机器管理插件。

目标：被控端（Windows / Linux）**主动出站**连接 DSH，由 DSH 生成一次性配对链接、自动登记机器并下发命令；后续增加交互终端（PTY）和文件传输。

## 下载

- [最新 Release](https://github.com/weiweisudo/dsh-plugin-remote-shell/releases/latest)
- Windows：`remote-agent-windows-amd64.exe`
- Linux：`remote-agent-linux-amd64`

## 为什么

- 目标机经常没有 sshd / WinRM，或不允许开系统服务
- 家宽 CGNAT，无法依赖入站端口
- 希望像 browser-skill 一样：被控端主动连出，DSH 侧统一管理

## 状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 出站连接 + 机器台账 + `remote_exec` | Linux 验收通过 |
| P0.5 | 配对链接 / 自动注册 / 180 天凭证 / 插件明暗主题 | Linux 验收通过 |
| P0.5-Win | 托盘 + 本地设置 UI + Windows 服务 | 已交叉编译，待 Windows 实机验收 |
| P1 | 审计、续期细节、更多设备管理 | 未开始 |
| P2 | 交互终端（ConPTY / pty） | 未开始 |
| P3 | 文件传输（白名单目录） | 未开始 |

## 目标架构

```
Windows / Linux 目标机
  └─ remote-agent（Go 单文件）
        │ 出站 WebSocket（配对 / 设备凭证 + 心跳 + 重连）
        ▼
DSH 插件「远程机器」监听 0.0.0.0:47777
  ├─ /api/remote-shell/agent      配对、注册、心跳、命令
  ├─ 机器台账（设备凭证只存 SHA-256）
  ├─ 工具：remote_hosts / remote_exec
  └─ 设置页：生成一次性链接、自动列表、撤销、明暗跟随 DSH
```

## 配对流程

1. 在 DSH 插件页「配对地址」里添加多个入口：名称 + 前缀（不添加则自动使用 LAN 地址）
2. 点「生成连接链接」，得到一次性链接（5 分钟有效，secret 在 `#` fragment 中）：

```
wss://agent6.potatooo.top:777/api/remote-shell/agent#<SECRET>
```

前缀建议指向 Lucky / Cloudflare 的公网入口；插件实际监听仍是内部的 `47777`。

3. 在目标机运行：

```bash
remote-agent --pair 'ws://192.168.5.8:47777/api/remote-shell/agent#<SECRET>'
```

4. agent 首次连接后自动登记，并保存 **180 天设备凭证**
5. 之后直接运行 `remote-agent` 即可用凭证重连，不再需要链接

DSH 侧不再需要“先创建机器”。

## Windows Agent

单文件 `remote-agent.exe`，默认托盘模式：

```powershell
# 单机托盘 + 本地设置页
.\remote-agent.exe

# 安装/解除 Windows 服务（需管理员）
.\remote-agent.exe service install
.\remote-agent.exe service uninstall
```

- GUI 子系统，双击不弹控制台窗口；只有托盘图标
- 托盘菜单：打开设置 / 重连 / 安装服务 / 解除服务 / 退出
- 关闭浏览器设置页不会退出；托盘继续运行
- CLI 命令（service install 等）会自动附加到父控制台
- 本地设置页端口：`49777–49796` 自动避让，仅绑 `127.0.0.1`
- 服务模式：LocalSystem、自动启动、失败重启；无托盘/窗口
- 设置页跟随 **Windows 系统明暗**

## Linux Agent

保留 headless 二进制，不做 GUI/服务安装器：

```bash
./remote-agent-linux-amd64 --pair 'ws://192.168.5.8:47777/api/remote-shell/agent#<SECRET>'
```

Linux 其他机器优先建议 SSH；agent 只用于没有 sshd / NAT 后的边缘场景。

## 目录

```
agent/    Go agent（Linux headless + Windows tray/service）
plugin/   DSH 插件 bundle
docs/     计划、验收、Windows 说明
```

## 连续执行与权限

- `remote_exec` 是**一次性命令**：每次新 shell，`cd` / 变量不跨命令，没有交互 stdin
- 需要连续状态时用 `remote_session_*`：持久 shell，每条命令仍返回 exit code / stdout / stderr / cwd
- 真正的交互终端（xterm / ConPTY）仍未实现，agent 不需要读终端屏幕
- Windows 上当前 agent 若以普通权限启动，UAC 过滤后是 Medium；需要管理员请安装为服务（LocalSystem）或以管理员身份启动
- UAC 不能静默绕过；无人值守优先用服务模式

## 安全

- agent 仅以运行它的用户权限执行命令，**不提供提权**
- 配对 secret 只存 SHA-256；一次性、5 分钟
- 设备凭证 180 天，插件侧只存哈希；撤销后立即断开
- 插件 agent 端口默认 `0.0.0.0:47777`，仅 token 保护；不要直接映射公网
- 文件传输阶段必须使用目录白名单（P3）

## 许可

上游 agent 为 MIT，派生代码必须保留版权声明。详见 [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md)。
本仓库自身许可待定。
