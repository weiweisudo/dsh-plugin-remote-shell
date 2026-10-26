# agent

Go 单文件 agent，派生自 [mcp-windows-remote-shell](https://github.com/laatortuejaune/mcp-windows-remote-shell)（MIT）。

## 能力

- 主动出站 WebSocket，目标机不监听入站端口
- 一次性配对链接 `--pair`，首次连接自动登记并保存 180 天设备凭证
- 设备凭证重连；配对 secret 只用于首次握手
- 非交互命令：Windows `cmd /c`，Linux `sh -c`
- 输出上限、超时、进程组 / Job Object 监管（沿用上游）

## Linux（headless）

```bash
./remote-agent --pair 'ws://192.168.5.8:47777/api/remote-shell/agent#SECRET'
./remote-agent                 # 用 ~/.dsh/remote-shell/credentials.json 重连
```

## Windows

```powershell
.\remote-agent.exe                 # 托盘 + 本地设置页 + worker
.\remote-agent.exe service install # 安装服务（管理员）
.\remote-agent.exe service uninstall
.\remote-agent.exe --service       # SCM 内部入口
```

- 本地设置页端口 `49777–49796`，只绑 `127.0.0.1`
- 关闭设置页不退出；托盘继续运行
- 详见 [docs/windows-agent.md](../docs/windows-agent.md)

## 构建

```bash
GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -o ../dist/remote-agent-linux-amd64 .
GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o ../dist/remote-agent-windows-amd64.exe .
```

## 不做

- 提权
- Linux GUI / 服务安装器
- PTY（P2）
- 文件传输（P3）
