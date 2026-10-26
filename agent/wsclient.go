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
	"path/filepath"
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
	Type           string    `json:"type"`
	ID             string    `json:"id,omitempty"`
	MachineID      string    `json:"machine_id,omitempty"`
	Name           string    `json:"name,omitempty"`
	OS             string    `json:"os,omitempty"`
	Arch           string    `json:"arch,omitempty"`
	Version        string    `json:"version,omitempty"`
	Features       []string  `json:"features,omitempty"`
	DeviceToken    string    `json:"device_token,omitempty"`
	ExpiresAt      string    `json:"expires_at,omitempty"`
	Time           string    `json:"time,omitempty"`
	Command        string    `json:"command,omitempty"`
	Shell          string    `json:"shell,omitempty"`
	SessionID      string    `json:"session_id,omitempty"`
	JobID          string    `json:"job_id,omitempty"`
	CWD            string    `json:"cwd,omitempty"`
	WaitMS         int       `json:"wait_ms,omitempty"`
	TailBytes      int       `json:"tail_bytes,omitempty"`
	Status         string    `json:"status,omitempty"`
	StartedAt      string    `json:"started_at,omitempty"`
	BytesOut       int64     `json:"bytes_out,omitempty"`
	BytesErr       int64     `json:"bytes_err,omitempty"`
	StdoutTail     string    `json:"stdout_tail,omitempty"`
	StderrTail     string    `json:"stderr_tail,omitempty"`
	Jobs           []wireJob `json:"jobs,omitempty"`
	TimeoutSeconds int       `json:"timeout_seconds,omitempty"`
	ExitCode       int       `json:"exit_code"`
	Stdout         string    `json:"stdout,omitempty"`
	Stderr         string    `json:"stderr,omitempty"`
	TimedOut       bool      `json:"timed_out,omitempty"`
	Truncated      bool      `json:"truncated,omitempty"`
	DurationMS     int64     `json:"duration_ms,omitempty"`
	Error          string    `json:"error,omitempty"`
}

type workerStatus struct {
	Online    bool
	MachineID string
	ExpiresAt string
	Error     string
}

type wireJob struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Command    string `json:"command"`
	Shell      string `json:"shell"`
	CWD        string `json:"cwd"`
	Status     string `json:"status"`
	ExitCode   int    `json:"exit_code"`
	StartedAt  string `json:"started_at"`
	DurationMS int64  `json:"duration_ms"`
	BytesOut   int64  `json:"bytes_out"`
	BytesErr   int64  `json:"bytes_err"`
	StdoutTail string `json:"stdout_tail"`
	StderrTail string `json:"stderr_tail"`
	Truncated  bool   `json:"truncated"`
}

type fatalError struct{ err error }

func (e fatalError) Error() string { return e.err.Error() }
func (e fatalError) Unwrap() error { return e.err }

func runOutbound(cfg *config) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runOutboundContext(ctx, cfg)
}

func runOutboundContext(ctx context.Context, cfg *config) error {
	if cfg.credentialsFile != "" {
		if _, err := ensureJobManager(filepath.Join(filepath.Dir(cfg.credentialsFile), "jobs")); err != nil {
			log.Printf("jobs: cannot initialize output directory: %v", err)
		}
	}
	u, err := url.Parse(cfg.serverURL)
	if err != nil {
		return fmt.Errorf("invalid --server: %w", err)
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return fmt.Errorf("invalid --server: scheme must be ws or wss")
	}
	if cfg.token == "" && cfg.pairSecret == "" {
		return errors.New("invalid agent configuration: empty token and pairing secret")
	}

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

func connectOutbound(ctx context.Context, cfg *config) (bool, error) {
	defer func() {
		if cfg.onStatus != nil {
			cfg.onStatus(workerStatus{Online: false})
		}
	}()
	header := http.Header{}
	authToken := cfg.token
	if cfg.pairSecret != "" {
		authToken = cfg.pairSecret
	}
	header.Set("Authorization", "Bearer "+authToken)
	if cfg.machineID != "" {
		header.Set("X-Machine-Id", cfg.machineID)
	}

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
	sessions := newSessionManager()
	defer sessions.closeAll()

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
		Features:  []string{"jobs", "sessions", "shell"},
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
			if msg.DeviceToken != "" {
				cfg.token = msg.DeviceToken
				cfg.pairSecret = ""
				if msg.MachineID != "" {
					cfg.machineID = msg.MachineID
				}
				if err := saveCredentials(cfg.credentialsFile, cfg.serverURL, cfg.machineID, cfg.token, msg.ExpiresAt); err != nil {
					log.Printf("credentials: save failed: %v", err)
				} else {
					log.Printf("credentials: saved machine_id=%s expires=%s", cfg.machineID, msg.ExpiresAt)
				}
				log.Printf("outbound: paired machine_id=%s expires=%s", cfg.machineID, msg.ExpiresAt)
			} else {
				log.Printf("outbound: registered machine_id=%s expires=%s", cfg.machineID, msg.ExpiresAt)
			}
			if cfg.onStatus != nil {
				cfg.onStatus(workerStatus{Online: true, MachineID: cfg.machineID, ExpiresAt: msg.ExpiresAt})
			}
		case "ping":
			_ = send(wireMessage{Type: "pong", Time: time.Now().UTC().Format(time.RFC3339)})
		case "job_start":
			if msg.ID == "" || msg.Command == "" {
				_ = send(wireMessage{Type: "job_error", ID: msg.ID, Error: "missing request or command"})
				continue
			}
			go func(m wireMessage) {
				jm := jobManagerOrNil()
				if jm == nil {
					_ = send(wireMessage{Type: "job_error", ID: m.ID, Error: "job manager is not initialized"})
					return
				}
				j, err := jm.start(m.Command, m.Shell, m.CWD, m.Name)
				if err != nil {
					_ = send(wireMessage{Type: "job_error", ID: m.ID, Error: err.Error()})
					return
				}
				_ = send(wireMessage{Type: "job_started", ID: m.ID, JobID: j.id, Status: "running", StartedAt: j.startedAt.UTC().Format(time.RFC3339)})
			}(msg)
		case "job_status":
			if msg.ID == "" || msg.JobID == "" {
				_ = send(wireMessage{Type: "job_error", ID: msg.ID, JobID: msg.JobID, Error: "missing request or job id"})
				continue
			}
			go func(m wireMessage) {
				jm := jobManagerOrNil()
				j := (*job)(nil)
				if jm != nil {
					j = jm.get(m.JobID)
				}
				if j == nil {
					_ = send(wireMessage{Type: "job_error", ID: m.ID, JobID: m.JobID, Error: "job not found"})
					return
				}
				wait := time.Duration(m.WaitMS) * time.Millisecond
				if wait < 0 || wait > 30*time.Second {
					wait = 0
				}
				snap := j.snapshot(wait, m.TailBytes)
				_ = send(wireMessage{
					Type: "job_status_result", ID: m.ID, JobID: snap.ID, Name: snap.Name, Command: snap.Command,
					Shell: snap.Shell, CWD: snap.CWD, Status: snap.Status, ExitCode: snap.ExitCode, StartedAt: snap.StartedAt,
					DurationMS: snap.DurationMS, BytesOut: snap.BytesOut, BytesErr: snap.BytesErr,
					StdoutTail: snap.StdoutTail, StderrTail: snap.StderrTail, Truncated: snap.Truncated,
				})
			}(msg)
		case "job_cancel":
			if msg.ID == "" || msg.JobID == "" {
				_ = send(wireMessage{Type: "job_error", ID: msg.ID, JobID: msg.JobID, Error: "missing request or job id"})
				continue
			}
			go func(m wireMessage) {
				jm := jobManagerOrNil()
				if jm == nil {
					_ = send(wireMessage{Type: "job_error", ID: m.ID, JobID: m.JobID, Error: "job manager is not initialized"})
					return
				}
				j, err := jm.cancel(m.JobID)
				if err != nil {
					_ = send(wireMessage{Type: "job_error", ID: m.ID, JobID: m.JobID, Error: err.Error()})
					return
				}
				snap := j.snapshot(time.Second, 4096)
				_ = send(wireMessage{
					Type: "job_canceled", ID: m.ID, JobID: snap.ID, Status: snap.Status, ExitCode: snap.ExitCode,
					DurationMS: snap.DurationMS, BytesOut: snap.BytesOut, BytesErr: snap.BytesErr,
					StdoutTail: snap.StdoutTail, StderrTail: snap.StderrTail, Truncated: snap.Truncated,
				})
			}(msg)
		case "job_list":
			go func(m wireMessage) {
				jm := jobManagerOrNil()
				if jm == nil {
					_ = send(wireMessage{Type: "job_error", ID: m.ID, Error: "job manager is not initialized"})
					return
				}
				list := jm.list()
				wire := make([]wireJob, 0, len(list))
				for _, j := range list {
					wire = append(wire, wireJob{ID: j.ID, Name: j.Name, Command: j.Command, Shell: j.Shell, CWD: j.CWD, Status: j.Status, ExitCode: j.ExitCode, StartedAt: j.StartedAt, DurationMS: j.DurationMS, BytesOut: j.BytesOut, BytesErr: j.BytesErr, StdoutTail: j.StdoutTail, StderrTail: j.StderrTail, Truncated: j.Truncated})
				}
				_ = send(wireMessage{Type: "job_list_result", ID: m.ID, Jobs: wire})
			}(msg)
		case "session_open":
			if msg.ID == "" || msg.SessionID == "" {
				_ = send(wireMessage{Type: "session_error", ID: msg.ID, SessionID: msg.SessionID, Error: "missing request or session id"})
				continue
			}
			go func(m wireMessage) {
				sess, err := sessions.open(m.SessionID, m.Shell, m.CWD)
				if err != nil {
					_ = send(wireMessage{Type: "session_error", ID: m.ID, SessionID: m.SessionID, Error: err.Error()})
					return
				}
				_ = send(wireMessage{Type: "session_opened", ID: m.ID, SessionID: m.SessionID, Shell: sess.shell, CWD: m.CWD})
			}(msg)
		case "session_exec":
			if msg.ID == "" || msg.SessionID == "" || msg.Command == "" {
				_ = send(wireMessage{Type: "session_error", ID: msg.ID, SessionID: msg.SessionID, Error: "missing request, session or command"})
				continue
			}
			sess := sessions.get(msg.SessionID)
			if sess == nil {
				_ = send(wireMessage{Type: "session_error", ID: msg.ID, SessionID: msg.SessionID, Error: "session not found"})
				continue
			}
			go func(m wireMessage, sess *shellSession) {
				timeout := cfg.timeout
				if m.TimeoutSeconds > 0 {
					timeout = time.Duration(m.TimeoutSeconds) * time.Second
				}
				if timeout <= 0 || timeout > maxTimeout {
					timeout = cfg.timeout
				}
				runCtx, cancel := context.WithTimeout(connCtx, timeout)
				defer cancel()
				res, err := sess.exec(runCtx, m.Command, timeout)
				if err != nil {
					_ = send(wireMessage{Type: "session_error", ID: m.ID, SessionID: m.SessionID, Error: err.Error(), TimedOut: res.TimedOut})
					if res.TimedOut {
						sessions.remove(m.SessionID)
					}
					return
				}
				_ = send(wireMessage{
					Type:       "session_result",
					ID:         m.ID,
					SessionID:  m.SessionID,
					ExitCode:   res.ExitCode,
					Stdout:     res.Stdout,
					Stderr:     res.Stderr,
					Truncated:  res.Truncated,
					TimedOut:   res.TimedOut,
					DurationMS: res.DurationMS,
					CWD:        res.CWD,
				})
			}(msg, sess)
		case "session_close":
			sessions.remove(msg.SessionID)
			_ = send(wireMessage{Type: "session_closed", ID: msg.ID, SessionID: msg.SessionID})
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
				exitCode, runErr := runCommandShell(runCtx, m.Command, m.Shell, stdout, stderr)
				resp := wireMessage{
					Type:       "exec_result",
					ID:         m.ID,
					ExitCode:   exitCode,
					Stdout:     decodeShellOutput(m.Shell, stdout.buf),
					Stderr:     decodeShellOutput(m.Shell, stderr.buf),
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
