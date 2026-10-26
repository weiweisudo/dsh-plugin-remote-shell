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

## 已知限制

- 交叉编译已通过，尚未在 Windows 实机验收托盘/服务
- `service install` 需要管理员；UI 里非管理员会返回错误
- 服务安装后，单机托盘会停止自己的 worker，避免重复连接
- 解除服务需要管理员；服务停止是异步的，安装器会等待
