package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsWriteTimeout = 10 * time.Second
	wsPongWait     = 90 * time.Second
	wsPingEvery    = 30 * time.Second
	maxConcurrent  = 4
)

type wireMessage struct {
	Type           string `json:"type"`
	ID             string `json:"id,omitempty"`
	MachineID      string `json:"machine_id,omitempty"`
	Name           string `json:"name,omitempty"`
	OS             string `json:"os,omitempty"`
	Arch           string `json:"arch,omitempty"`
	Version        string `json:"version,omitempty"`
	Time           string `json:"time,omitempty"`
	Command        string `json:"command,omitempty"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
	ExitCode       int    `json:"exit_code"`
	Stdout         string `json:"stdout,omitempty"`
	Stderr         string `json:"stderr,omitempty"`
	TimedOut       bool   `json:"timed_out,omitempty"`
	Truncated      bool   `json:"truncated,omitempty"`
	DurationMS     int64  `json:"duration_ms,omitempty"`
	Error          string `json:"error,omitempty"`
}

type fatalError struct{ err error }

func (e fatalError) Error() string { return e.err.Error() }
func (e fatalError) Unwrap() error { return e.err }

func runOutbound(cfg config) error {
	u, err := url.Parse(cfg.serverURL)
	if err != nil {
		return fmt.Errorf("invalid --server: %w", err)
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return fmt.Errorf("invalid --server: scheme must be ws or wss")
	}
	if cfg.token == "" {
		return errors.New("invalid agent configuration: empty token")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return nil
		}
		connected, err := connectOutbound(ctx, cfg)
		if ctx.Err() != nil {
			return nil
		}
		var fatal fatalError
		if errors.As(err, &fatal) {
			return fatal.err
		}
		if connected {
			backoff = time.Second
		}
		if err != nil {
			log.Printf("outbound: %v; reconnect in %s", err, backoff)
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return nil
		}
		if backoff < 60*time.Second {
			backoff *= 2
			if backoff > 60*time.Second {
				backoff = 60 * time.Second
			}
		}
	}
}

func connectOutbound(ctx context.Context, cfg config) (bool, error) {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.token)
	header.Set("X-Machine-Id", cfg.machineID)

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	conn, resp, err := dialer.DialContext(ctx, cfg.serverURL, header)
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return false, fatalError{fmt.Errorf("outbound rejected: HTTP %d", resp.StatusCode)}
		}
		return false, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	conn.SetReadLimit(maxStreamBytes + maxRequestBytes)
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	commands := newCommandManager()
	defer commands.stop()

	// Close the socket when the process is asked to stop; a blocked ReadJSON
	// would otherwise ignore context cancellation and keep the agent alive.
	stopClose := make(chan struct{})
	go func() {
		select {
		case <-connCtx.Done():
			_ = conn.Close()
		case <-stopClose:
		}
	}()
	defer close(stopClose)

	var writeMu sync.Mutex
	send := func(msg wireMessage) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		return conn.WriteJSON(msg)
	}

	hostname := cfg.name
	if hostname == "" {
		hostname, _ = os.Hostname()
	}
	if err := send(wireMessage{
		Type:      "hello",
		MachineID: cfg.machineID,
		Name:      hostname,
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Version:   version,
		Time:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		return false, fmt.Errorf("hello: %w", err)
	}

	stopHeartbeat := make(chan struct{})
	var heartbeatWG sync.WaitGroup
	heartbeatWG.Add(1)
	go func() {
		defer heartbeatWG.Done()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := send(wireMessage{Type: "heartbeat", Time: time.Now().UTC().Format(time.RFC3339)}); err != nil {
					_ = conn.Close()
					return
				}
			case <-stopHeartbeat:
				return
			case <-connCtx.Done():
				return
			}
		}
	}()
	defer func() {
		close(stopHeartbeat)
		heartbeatWG.Wait()
	}()

	conn.SetPingHandler(func(appData string) error {
		_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(wsWriteTimeout))
	})

	connected := true
	for {
		var msg wireMessage
		if err := conn.ReadJSON(&msg); err != nil {
			var ce *websocket.CloseError
			if errors.As(err, &ce) && (ce.Code == 4001 || ce.Code == 4003) {
				return connected, fatalError{fmt.Errorf("outbound closed: %s", ce.Text)}
			}
			return connected, err
		}
		_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
		switch msg.Type {
		case "hello_ok":
			log.Printf("outbound: registered machine_id=%s name=%s", cfg.machineID, hostname)
		case "ping":
			_ = send(wireMessage{Type: "pong", Time: time.Now().UTC().Format(time.RFC3339)})
		case "exec":
			if msg.ID == "" || msg.Command == "" {
				_ = send(wireMessage{Type: "exec_result", ID: msg.ID, ExitCode: -1, Error: "missing id or command"})
				continue
			}
			go func(m wireMessage) {
				if !commands.begin() {
					_ = send(wireMessage{Type: "exec_result", ID: m.ID, ExitCode: -1, Error: "agent is shutting down"})
					return
				}
				defer commands.active.Done()
				timeout := cfg.timeout
				if m.TimeoutSeconds > 0 {
					timeout = time.Duration(m.TimeoutSeconds) * time.Second
				}
				if timeout <= 0 || timeout > maxTimeout {
					timeout = cfg.timeout
				}
				runCtx, cancel := context.WithTimeout(connCtx, timeout)
				defer cancel()
				stdout := &capBuffer{limit: maxStreamBytes}
				stderr := &capBuffer{limit: maxStreamBytes}
				start := time.Now()
				exitCode, runErr := runCommand(runCtx, m.Command, stdout, stderr)
				resp := wireMessage{
					Type:       "exec_result",
					ID:         m.ID,
					ExitCode:   exitCode,
					Stdout:     stdout.String(),
					Stderr:     stderr.String(),
					Truncated:  stdout.truncated || stderr.truncated,
					DurationMS: time.Since(start).Milliseconds(),
				}
				switch {
				case runErr == nil:
					resp.ExitCode = 0
				case runCtx.Err() == context.DeadlineExceeded:
					resp.TimedOut = true
					resp.ExitCode = -1
				default:
					resp.ExitCode = exitCode
				}
				if resp.Stderr == "" && runErr != nil {
					resp.Stderr = runErr.Error()
				}
				_ = send(resp)
			}(msg)
		}
	}
}
