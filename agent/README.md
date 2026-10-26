# agent（P0 待实现）

Go 单文件 agent，计划从 [mcp-windows-remote-shell](https://github.com/laatortuejaune/mcp-windows-remote-shell) 的 `agent/` 派生（MIT）。

## 目标

- 仅监听 `127.0.0.1`，不暴露入站端口
- 主动出站 WSS 连接 DSH
- Bearer token 鉴权
- 非交互命令执行：Windows `cmd /c`，Linux `sh -c`
- 输出上限、超时、进程组/Job Object 监管（沿用上游）

## P0 启动参数（草案）

```
remote-agent --server wss://dsh6.potatooo.top:777/api/remote-shell/agent \
             --machine-id m_xxx --token-file token.txt --name "Windows PC"
```

## 构建

```
GOOS=linux   GOARCH=amd64 go build -o dist/remote-agent-linux-amd64 ./cmd/agent
GOOS=windows GOARCH=amd64 go build -o dist/remote-agent-windows-amd64.exe ./cmd/agent
```

## 不做

- 提权 / SYSTEM 服务
- PTY（P1）
- 文件传输（P2）
