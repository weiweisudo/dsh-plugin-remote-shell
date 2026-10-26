//go:build windows

package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os/exec"
	"sync"
	"time"

	"github.com/getlantern/systray"
)

//go:embed assets/tray.ico
var trayIcon []byte

const (
	serviceName = "dsh-remote-shell"
	uiPortFirst = 49777
	uiPortLast  = 49796
)

type desktopApp struct {
	mu       sync.Mutex
	cfg      config
	status   workerStatus
	cancel   context.CancelFunc
	server   *http.Server
	listener net.Listener
	token    string
	uiURL    string

	mStatus    *systray.MenuItem
	mOpen      *systray.MenuItem
	mReconnect *systray.MenuItem
	mInstall   *systray.MenuItem
	mUninstall *systray.MenuItem
	mQuit      *systray.MenuItem
}

func runDesktop(cfg *config) error {
	if cfg == nil {
		cfg = defaultDesktopConfig()
	}
	app := &desktopApp{cfg: *cfg}
	if err := app.startUI(); err != nil {
		return err
	}
	app.startWorker()
	log.Printf("desktop: settings at %s", app.uiURL)
	systray.Run(app.onReady, app.onExit)
	return nil
}

func (a *desktopApp) startUI() error {
	var err error
	a.listener, err = listenUILoopback()
	if err != nil {
		return err
	}
	token := make([]byte, 18)
	if _, err := rand.Read(token); err != nil {
		return err
	}
	a.token = hex.EncodeToString(token)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		_, _ = io.WriteString(w, desktopHTML)
	})
	mux.HandleFunc("/api/status", a.auth(a.handleStatus))
	mux.HandleFunc("/api/pair", a.auth(a.handlePair))
	mux.HandleFunc("/api/reconnect", a.auth(a.handleReconnect))
	mux.HandleFunc("/api/service/install", a.auth(a.handleInstallService))
	mux.HandleFunc("/api/service/uninstall", a.auth(a.handleUninstallService))
	mux.HandleFunc("/api/quit", a.auth(a.handleQuit))
	a.server = &http.Server{Handler: mux}
	go func() {
		if err := a.server.Serve(a.listener); err != nil && err != http.ErrServerClosed {
			log.Printf("desktop: UI server: %v", err)
		}
	}()
	port := a.listener.Addr().(*net.TCPAddr).Port
	a.uiURL = fmt.Sprintf("http://127.0.0.1:%d/#token=%s", port, a.token)
	return nil
}

func listenUILoopback() (net.Listener, error) {
	for port := uiPortFirst; port <= uiPortLast; port++ {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			return ln, nil
		}
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

func (a *desktopApp) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-RS-Token")
		if token == "" {
			if c, err := r.Cookie("rs_token"); err == nil {
				token = c.Value
			}
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(a.token)) != 1 {
			writeJSONReply(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

func writeJSONReply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (a *desktopApp) startWorker() {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	// Prefer a saved device credential unless we are starting a fresh pairing.
	if a.cfg.pairSecret == "" && a.cfg.token == "" {
		if c, err := loadCredentials(a.cfg.credentialsFile); err == nil {
			if a.cfg.serverURL == "" || a.cfg.serverURL == c.Endpoint {
				a.cfg.serverURL = c.Endpoint
				a.cfg.machineID = c.MachineID
				a.cfg.token = c.Token
			}
		}
	}
	if a.cfg.serverURL == "" {
		a.status = workerStatus{Error: "未配对：先粘贴连接链接"}
		a.mu.Unlock()
		a.refreshTray()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.status = workerStatus{Error: "连接中…"}
	cfg := a.cfg
	cfg.onStatus = func(s workerStatus) {
		a.mu.Lock()
		a.status = s
		a.mu.Unlock()
		a.refreshTray()
	}
	a.mu.Unlock()
	go func() {
		if err := runOutboundContext(ctx, &cfg); err != nil {
			a.mu.Lock()
			a.status = workerStatus{Error: err.Error()}
			a.mu.Unlock()
			a.refreshTray()
		}
	}()
}

func (a *desktopApp) stopWorker() {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	a.mu.Unlock()
}

func (a *desktopApp) pair(link string) error {
	endpoint, secret, err := parsePairLink(link)
	if err != nil {
		return err
	}
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	a.cfg.serverURL = endpoint
	a.cfg.pairSecret = secret
	a.cfg.machineID = ""
	a.cfg.token = ""
	a.status = workerStatus{Error: "配对中…"}
	a.mu.Unlock()
	a.startWorker()
	return nil
}

func (a *desktopApp) refreshTray() {
	a.mu.Lock()
	status := a.status
	a.mu.Unlock()
	text := "离线"
	if status.Online {
		text = "在线"
	} else if status.Error != "" {
		text = status.Error
	}
	if len(text) > 40 {
		text = text[:40] + "…"
	}
	if a.mStatus != nil {
		a.mStatus.SetTitle("状态：" + text)
	}
	systray.SetTooltip("DSH Remote Shell — " + text)
}

func (a *desktopApp) onReady() {
	systray.SetIcon(trayIcon)
	systray.SetTitle("DSH")
	systray.SetTooltip("DSH Remote Shell")
	a.mStatus = systray.AddMenuItem("状态：启动中", "")
	a.mStatus.Disable()
	a.mOpen = systray.AddMenuItem("打开设置", "打开本地设置页")
	a.mReconnect = systray.AddMenuItem("重新连接", "重新加载凭证并连接")
	systray.AddSeparator()
	a.mInstall = systray.AddMenuItem("安装为 Windows 服务", "需要管理员权限")
	a.mUninstall = systray.AddMenuItem("解除 Windows 服务", "需要管理员权限")
	systray.AddSeparator()
	a.mQuit = systray.AddMenuItem("退出", "退出托盘和后台连接")
	go func() {
		for {
			select {
			case <-a.mOpen.ClickedCh:
				a.openUI()
			case <-a.mReconnect.ClickedCh:
				a.startWorker()
			case <-a.mInstall.ClickedCh:
				if err := installService(a.cfg.credentialsFile); err != nil {
					log.Printf("desktop: install service: %v", err)
				} else {
					a.stopWorker()
					a.mu.Lock()
					a.status = workerStatus{Error: "已切换为 Windows 服务模式"}
					a.mu.Unlock()
					a.refreshTray()
				}
			case <-a.mUninstall.ClickedCh:
				if err := uninstallService(); err != nil {
					log.Printf("desktop: uninstall service: %v", err)
				}
			case <-a.mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
	a.refreshTray()
}

func (a *desktopApp) onExit() {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	server := a.server
	a.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
}

func (a *desktopApp) openUI() {
	if a.uiURL == "" {
		return
	}
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", a.uiURL).Start()
}

func (a *desktopApp) handleStatus(w http.ResponseWriter, _ *http.Request) {
	a.mu.Lock()
	status := a.status
	cfg := a.cfg
	a.mu.Unlock()
	installed, running, serviceErr := queryServiceState()
	configured := false
	if _, err := loadCredentials(cfg.credentialsFile); err == nil {
		configured = true
	}
	writeJSONReply(w, http.StatusOK, map[string]any{
		"ok":                true,
		"online":            status.Online,
		"machine_id":        status.MachineID,
		"expires_at":        status.ExpiresAt,
		"error":             status.Error,
		"configured":        configured,
		"service_installed": installed,
		"service_running":   running,
		"service_error":     serviceErr,
		"version":           version,
	})
}

func (a *desktopApp) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONReply(w, http.StatusMethodNotAllowed, map[string]any{"ok": false})
		return
	}
	var body struct {
		Link string `json:"link"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONReply(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON"})
		return
	}
	if err := a.pair(body.Link); err != nil {
		writeJSONReply(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSONReply(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *desktopApp) handleReconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONReply(w, http.StatusMethodNotAllowed, map[string]any{"ok": false})
		return
	}
	a.startWorker()
	writeJSONReply(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *desktopApp) handleInstallService(w http.ResponseWriter, _ *http.Request) {
	if err := installService(a.cfg.credentialsFile); err != nil {
		writeJSONReply(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	a.stopWorker()
	a.mu.Lock()
	a.status = workerStatus{Error: "已切换为 Windows 服务模式"}
	a.mu.Unlock()
	a.refreshTray()
	writeJSONReply(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *desktopApp) handleUninstallService(w http.ResponseWriter, _ *http.Request) {
	if err := uninstallService(); err != nil {
		writeJSONReply(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	a.startWorker()
	writeJSONReply(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *desktopApp) handleQuit(w http.ResponseWriter, _ *http.Request) {
	writeJSONReply(w, http.StatusOK, map[string]any{"ok": true})
	go func() {
		time.Sleep(100 * time.Millisecond)
		systray.Quit()
	}()
}
