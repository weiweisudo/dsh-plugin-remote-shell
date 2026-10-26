GO ?= go
GOPROXY ?= https://goproxy.cn,direct
AGENT_BIN ?= dist/remote-agent-linux-amd64

.PHONY: all build test agent-linux agent-windows clean

all: agent-linux agent-windows

agent-linux:
	cd agent && GOPROXY=$(GOPROXY) CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags="-s -w" -o ../dist/remote-agent-linux-amd64 .

agent-windows:
	cd agent && GOPROXY=$(GOPROXY) CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GO) build -trimpath -ldflags="-H windowsgui -s -w" -o ../dist/remote-agent-windows-amd64.exe .

test:
	cd agent && GOPROXY=$(GOPROXY) $(GO) test ./...
	node --check plugin/lib/index.mjs
	node --check plugin/lib/client.js

clean:
	rm -rf dist
